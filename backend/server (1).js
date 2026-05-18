'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const MONGODB_URI  = process.env.MONGODB_URI  || '';
const DB_NAME      = process.env.DB_NAME      || '';
const BOT_USERNAME = process.env.BOT_USERNAME || 'YourSeriesBot';

// ─── Bot proxy config ─────────────────────────────────────────────────────────
// BOT_URL points to your Koyeb-deployed SeriesBot (aiohttp server).
// All /latest, /request, /releases, /poster pages and their /api/* calls
// are forwarded there so the Vercel site can open them.
const BOT_URL = (process.env.BOT_URL || 'https://sfbot.koyeb.app').replace(/\/$/, '');

let db;
async function connectDB() {
  if (!MONGODB_URI || !DB_NAME) {
    throw new Error('MONGODB_URI and DB_NAME environment variables must be set');
  }
  if (db) return; // already connected
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`✅  MongoDB connected → ${DB_NAME}`);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively strips out empty objects / null branches from a nested plain object.
 * Used to clean MongoDB documents before sending to client.
 */
function stripEmpty(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = stripEmpty(v);
      if (Object.keys(inner).length > 0) out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Build a lightweight summary of a series document safe to send to the client.
 * Removes internal file IDs but keeps everything the UI needs.
 */
function serializeSeries(doc) {
  const {
    _id, title, year, genre, rating, imdb_id,
    poster_url, published, created_at, languages,
  } = doc;

  // Rebuild languages structure keeping only what UI needs
  const langs = {};
  for (const [lid, lang] of Object.entries(languages || {})) {
    if (!lang || !lang.name) continue;

    const seasons = {};
    for (const [sid, season] of Object.entries(lang.seasons || {})) {
      if (!season || !season.name) continue;

      // Season-level qualities (batch mode)
      const qualities = {};
      for (const [qid, q] of Object.entries(season.qualities || {})) {
        if (!q || !q.name) continue;
        if (!q.published) continue;          // only published qualities
        qualities[qid] = { name: q.name };  // never expose internal IDs
      }

      // Episode list
      const episodes = {};
      for (const [eid, ep] of Object.entries(season.episodes || {})) {
        if (!ep || !ep.name) continue;
        const epQualities = {};
        for (const [eqid, eq] of Object.entries(ep.qualities || {})) {
          if (!eq || !eq.name) continue;
          if (!eq.published) continue;
          epQualities[eqid] = { name: eq.name };
        }
        if (Object.keys(epQualities).length > 0) {
          episodes[eid] = { name: ep.name, qualities: epQualities };
        }
      }

      const hasQualities = Object.keys(qualities).length > 0;
      const hasEpisodes  = Object.keys(episodes).length  > 0;

      if (hasQualities || hasEpisodes) {
        seasons[sid] = {
          name: season.name,
          qualities,
          episodes,
        };
      }
    }

    if (Object.keys(seasons).length > 0) {
      langs[lid] = { name: lang.name, seasons };
    }
  }

  return {
    id: String(_id),
    title,
    year:       year  || '',
    genre:      genre || '',
    rating:     rating || '',
    poster_url: poster_url || '',
    created_at: created_at || null,
    languages:  langs,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/series — list all published series (with optional search)
app.get('/api/series', async (req, res) => {
  try {
    const q     = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const filter = { published: true };
    if (q) {
      filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const docs = await db
      .collection('series')
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    const series = docs.map(serializeSeries).filter(s => {
      // Only include series that have at least one navigable path
      return Object.keys(s.languages).length > 0;
    });

    res.json({ ok: true, series });
  } catch (err) {
    console.error('GET /api/series:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// GET /api/series/:id — single series detail
app.get('/api/series/:id', async (req, res) => {
  try {
    const doc = await db.collection('series').findOne({ _id: req.params.id, published: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, series: serializeSeries(doc) });
  } catch (err) {
    console.error('GET /api/series/:id:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/link
 * Build the Telegram deep-link for a specific file selection.
 *
 * Query params:
 *   series_id  — series _id
 *   lang_id    — language key
 *   season_id  — season key
 *   episode_id — episode key  (omit for batch)
 *   quality_id — quality key
 *   type       — 'file' | 'batch'
 *
 * The bot handles start= params:
 *   file_{msg_id}_{db_channel_id}   → single episode file
 *   batch_{series_id}_{lang_id}_{season_id}_{quality_id} → season batch
 */
app.get('/api/link', async (req, res) => {
  try {
    const { series_id, lang_id, season_id, episode_id, quality_id, type } = req.query;

    if (!series_id || !lang_id || !season_id || !quality_id) {
      return res.status(400).json({ ok: false, error: 'Missing required params' });
    }

    const doc = await db.collection('series').findOne({ _id: series_id, published: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Series not found' });

    const lang   = (doc.languages || {})[lang_id];
    if (!lang)   return res.status(404).json({ ok: false, error: 'Language not found' });

    const season = (lang.seasons || {})[season_id];
    if (!season) return res.status(404).json({ ok: false, error: 'Season not found' });

    let startParam;

    if (type === 'file' && episode_id) {
      // Single episode file
      const episode = (season.episodes || {})[episode_id];
      if (!episode) return res.status(404).json({ ok: false, error: 'Episode not found' });

      const eq = (episode.qualities || {})[quality_id];
      if (!eq || !eq.msg_id || !eq.published) {
        return res.status(404).json({ ok: false, error: 'Quality not available' });
      }

      // msg_id + db_channel_id encoded as start param
      const channelId = String(eq.db_channel_id || '').replace('-100', '');
      startParam = `file_${eq.msg_id}_${channelId}`;

    } else {
      // Batch (full season)
      const q = (season.qualities || {})[quality_id];
      if (!q || !q.published) {
        return res.status(404).json({ ok: false, error: 'Quality not available' });
      }

      // Support both batch_link stored and raw range params
      if (q.batch_link) {
        // Extract existing start param from stored link if it's a t.me link
        const match = q.batch_link.match(/start=([^&]+)/);
        if (match) {
          startParam = match[1];
        } else {
          // It might be a raw start param already
          startParam = q.batch_link;
        }
      } else if (q.first_msg_id && q.last_msg_id) {
        const channelId = String(q.db_channel_id || '').replace('-100', '');
        startParam = `batch_${q.first_msg_id}_${q.last_msg_id}_${channelId}`;
      } else {
        return res.status(404).json({ ok: false, error: 'Batch not available yet' });
      }
    }

    const botLink = `https://t.me/${BOT_USERNAME}?start=${startParam}`;
    res.json({ ok: true, bot_link: botLink });

  } catch (err) {
    console.error('GET /api/link:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// GET /api/config — expose safe client config
app.get('/api/config', (_req, res) => {
  res.json({ ok: true, bot_username: BOT_USERNAME });
});

// ─── Bot page proxies ─────────────────────────────────────────────────────────────────────────────
// These routes proxy the HTML pages and API calls served by the bot's aiohttp
// server, so they open at sfactory-pi.vercel.app/latest etc.

async function proxyBotPage(botPath, req, res) {
  try {
    const upstream = await fetch(`${BOT_URL}${botPath}`);
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Bot returned ${upstream.status}`);
    }
    const html = await upstream.text();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error(`proxyBotPage(${botPath}):`, err);
    res.status(502).send('Could not reach the bot server. Make sure BOT_URL is set correctly.');
  }
}

async function proxyBotApi(req, res) {
  try {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const botPath = req.path + qs;
    const options = { method: req.method, headers: { 'Content-Type': 'application/json' } };
    if (req.method === 'POST') options.body = JSON.stringify(req.body);
    const upstream = await fetch(`${BOT_URL}${botPath}`, options);
    const ct = upstream.headers.get('content-type') || 'application/json';
    const body = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', ct).send(body);
  } catch (err) {
    console.error(`proxyBotApi(${req.path}):`, err);
    res.status(502).json({ ok: false, error: 'Could not reach bot API' });
  }
}

// HTML page routes
app.get('/latest',   (req, res) => proxyBotPage('/latest',   req, res));
app.get('/request',  (req, res) => proxyBotPage('/request',  req, res));
app.get('/releases', (req, res) => proxyBotPage('/releases', req, res));
app.get('/poster',   (req, res) => proxyBotPage('/poster',   req, res));

// Bot API routes (proxied so fetch('/api/...') inside the HTML pages works)
app.all('/api/latest',         (req, res) => proxyBotApi(req, res));
app.all('/api/search/latest',  (req, res) => proxyBotApi(req, res));
app.all('/api/requests',       (req, res) => proxyBotApi(req, res));
app.all('/api/search/request', (req, res) => proxyBotApi(req, res));
app.all('/api/request/add',    (req, res) => proxyBotApi(req, res));
app.all('/api/releases',       (req, res) => proxyBotApi(req, res));
app.all('/api/file/get',       (req, res) => proxyBotApi(req, res));
app.all('/api/tmdb/search',    (req, res) => proxyBotApi(req, res));

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
// Vercel: export the app (serverless — no listen needed)
// Local:  call app.listen() normally
if (process.env.VERCEL) {
  // On Vercel, connect lazily on first request
  const origHandler = app.handle.bind(app);
  app.handle = async (req, res) => {
    if (!db) await connectDB();
    origHandler(req, res);
  };
  module.exports = app;
} else {
  (async () => {
    try {
      await connectDB();
      app.listen(PORT, () => console.log(`🚀  Server running on http://localhost:${PORT}`));
    } catch (err) {
      console.error('Startup error:', err);
      process.exit(1);
    }
  })();
}
