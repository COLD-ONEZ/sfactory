'use strict';

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const { MongoClient } = require('mongodb');
const fetch     = require('node-fetch');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Environment variables ─────────────────────────────────────────────────
const MONGODB_URI            = process.env.MONGODB_URI             || '';
const DB_NAME                = process.env.DB_NAME                 || '';
const BOT_USERNAME           = process.env.BOT_USERNAME            || 'YourSeriesBot';
const TMDB_API_KEY           = process.env.TMDB_API_KEY            || '';
const TMDB_READ_ACCESS_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN  || '';
const TVMAZE_API_KEY         = process.env.TVMAZE_API              || ''; // env name matches SeriesBoT
const IMGBB_API_KEY          = process.env.IMGBB_API_KEY           || '';
const CATBOX_API_KEY         = process.env.CATBOX_API_KEY          || '';

const MAX_WEEKLY_REQUESTS = 5;

// ─── MongoDB ───────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  if (!MONGODB_URI || !DB_NAME) throw new Error('MONGODB_URI and DB_NAME must be set');
  if (db) return;
  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  console.log(`✅  MongoDB connected → ${DB_NAME}`);
}

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — TMDB helpers
// ═══════════════════════════════════════════════════════════════════════════

const TMDB_BASE  = 'https://api.themoviedb.org/3';
const TMDB_W500  = 'https://image.tmdb.org/t/p/w500';
const TMDB_W1280 = 'https://image.tmdb.org/t/p/w1280';
const TMDB_ORIG  = 'https://image.tmdb.org/t/p/original';

/** Return fetch headers for TMDB — Bearer token preferred over api_key. */
function tmdbHeaders() {
  if (TMDB_READ_ACCESS_TOKEN) {
    return { Authorization: `Bearer ${TMDB_READ_ACCESS_TOKEN}`, Accept: 'application/json' };
  }
  return { Accept: 'application/json' };
}

/** Build full TMDB URL, appending api_key only when no Bearer token is set. */
function tmdbUrl(urlPath, params = {}) {
  const u = new URL(TMDB_BASE + urlPath);
  if (!TMDB_READ_ACCESS_TOKEN && TMDB_API_KEY) u.searchParams.set('api_key', TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function tmdbFetch(urlPath, params = {}) {
  const res = await fetch(tmdbUrl(urlPath, params), { headers: tmdbHeaders(), timeout: 15000 });
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${urlPath}`);
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Series serialiser (for /api/series routes)
// ═══════════════════════════════════════════════════════════════════════════

function serializeSeries(doc) {
  const { _id, title, year, genre, rating, poster_url, created_at, languages } = doc;
  const langs = {};
  for (const [lid, lang] of Object.entries(languages || {})) {
    if (!lang || !lang.name) continue;
    const seasons = {};
    for (const [sid, season] of Object.entries(lang.seasons || {})) {
      if (!season || !season.name) continue;
      const qualities = {};
      for (const [qid, q] of Object.entries(season.qualities || {})) {
        if (!q || !q.name || !q.published) continue;
        qualities[qid] = { name: q.name };
      }
      const episodes = {};
      for (const [eid, ep] of Object.entries(season.episodes || {})) {
        if (!ep || !ep.name) continue;
        const epQ = {};
        for (const [eqid, eq] of Object.entries(ep.qualities || {})) {
          if (!eq || !eq.name || !eq.published) continue;
          epQ[eqid] = { name: eq.name };
        }
        if (Object.keys(epQ).length > 0) episodes[eid] = { name: ep.name, qualities: epQ };
      }
      if (Object.keys(qualities).length > 0 || Object.keys(episodes).length > 0)
        seasons[sid] = { name: season.name, qualities, episodes };
    }
    if (Object.keys(seasons).length > 0) langs[lid] = { name: lang.name, seasons };
  }
  return {
    id: String(_id), title,
    year: year || '', genre: genre || '', rating: rating || '',
    poster_url: poster_url || '', created_at: created_at || null,
    languages: langs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — _buildInfoStr  (mirrors recent_list.py)
// Used by /api/search/latest and /api/file/get to derive links from raw
// series documents without the bot's pre-computed recent_list entries.
// ═══════════════════════════════════════════════════════════════════════════

function _seasonCode(name) {
  const m = (name || '').match(/\d+/);
  return m ? `S${String(parseInt(m[0])).padStart(2, '0')}` : (name || '');
}
function _extractResolution(n) {
  if (!n) return '';
  if (/\b4k\b/i.test(n)) return '4K';
  if (/\b2160p\b/i.test(n)) return '2160p';
  const m = n.match(/\b(\d{3,4}p)\b/i);
  return m ? m[1] : '';
}
function _resolutionRank(r) {
  if (!r) return 0;
  const u = r.toUpperCase();
  if (u === '4K' || u === '2160P') return 2160;
  const m = u.match(/^(\d+)P$/);
  return m ? parseInt(m[1]) : 0;
}
function _snum(name) {
  const m = (name || '').match(/\d+/);
  return m ? parseInt(m[0]) : 0;
}

function _buildInfoStr(seriesData) {
  const seasonMap = {};
  for (const langData of Object.values(seriesData.languages || {})) {
    for (const [, seasonData] of Object.entries(langData.seasons || {})) {
      const sNum  = _snum(seasonData.name || '');
      const sCode = _seasonCode(seasonData.name || '');
      let hasBatch = false, batchLink = null, seasonQuality = '', bestBatchRank = -1;
      for (const q of Object.values(seasonData.qualities || {})) {
        if (q.published && q.batch_link) {
          hasBatch = true;
          const res = _extractResolution(q.name || '');
          const rank = _resolutionRank(res);
          if (rank > bestBatchRank) { bestBatchRank = rank; batchLink = q.batch_link; seasonQuality = res; }
        }
      }
      const epDataMap = {};
      let epQuality = '', bestEpRank = -1;
      for (const epData of Object.values(seasonData.episodes || {})) {
        for (const q of Object.values(epData.qualities || {})) {
          if (q.published && q.file_link) {
            const epN = _snum(epData.name || '');
            epDataMap[epN] = q.file_link;
            const res = _extractResolution(q.name || '');
            const rank = _resolutionRank(res);
            if (rank > bestEpRank) { bestEpRank = rank; epQuality = res; }
          }
        }
      }
      if (!hasBatch && Object.keys(epDataMap).length === 0) continue;
      const rq = seasonQuality || epQuality;
      if (!(sNum in seasonMap)) {
        seasonMap[sNum] = { s_code: sCode, has_batch: hasBatch, ep_map: epDataMap, batch_link: batchLink, quality: rq };
      } else {
        seasonMap[sNum].has_batch = seasonMap[sNum].has_batch || hasBatch;
        Object.assign(seasonMap[sNum].ep_map, epDataMap);
        if (batchLink && !seasonMap[sNum].batch_link) seasonMap[sNum].batch_link = batchLink;
        if (_resolutionRank(rq) > _resolutionRank(seasonMap[sNum].quality)) seasonMap[sNum].quality = rq;
      }
    }
  }
  const keys = Object.keys(seasonMap).map(Number);
  if (!keys.length) return { info_str: '', is_season: true, season_num: 0, episode_num: null, batch_link: null, file_link: null, quality: '' };
  const latestSNum = Math.max(...keys);
  const latest     = seasonMap[latestSNum];
  const sortedEps  = Object.keys(latest.ep_map).map(Number).sort((a, b) => a - b);
  if (sortedEps.length > 0) {
    const latestEp = sortedEps[sortedEps.length - 1];
    return { info_str: `${latest.s_code}E${String(latestEp).padStart(2, '0')}`, is_season: false, season_num: latestSNum, episode_num: latestEp, batch_link: null, file_link: latest.ep_map[latestEp] || null, quality: latest.quality };
  }
  return { info_str: latest.s_code, is_season: true, season_num: latestSNum, episode_num: null, batch_link: latest.batch_link || null, file_link: null, quality: latest.quality };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Image upload helpers  (mirrors series.py upload functions)
// ImgBB first, Catbox as fallback. Operates on Buffer, no temp files needed.
// ═══════════════════════════════════════════════════════════════════════════

/** Upload a JPEG Buffer to ImgBB via base64. Returns URL or '' on failure. */
async function uploadToImgbb(imageBuffer) {
  if (!IMGBB_API_KEY) return '';
  try {
    const b64  = imageBuffer.toString('base64');
    const body = new URLSearchParams({ key: IMGBB_API_KEY, image: b64 });
    const res  = await fetch('https://api.imgbb.com/1/upload', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      timeout: 30000,
    });
    if (!res.ok) return '';
    const data = await res.json();
    if (!data.success) return '';
    const d = data.data || {};
    return d.display_url || (d.image && d.image.url) || d.url || '';
  } catch (e) {
    console.error('ImgBB upload error:', e.message);
    return '';
  }
}

/**
 * Upload a JPEG Buffer to Catbox.moe via multipart/form-data.
 * Uses Node 18+ built-in FormData + Blob (no extra packages).
 * Returns URL or '' on failure.
 */
async function uploadToCatbox(imageBuffer) {
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('userhash', CATBOX_API_KEY || '');
    form.append('fileToUpload', new Blob([imageBuffer], { type: 'image/jpeg' }), 'poster.jpg');
    const res = await fetch('https://catbox.moe/user/api.php', {
      method:  'POST',
      body:    form,
      timeout: 30000,
    });
    if (!res.ok) return '';
    const text = (await res.text()).trim();
    return text.startsWith('https://') ? text : '';
  } catch (e) {
    console.error('Catbox upload error:', e.message);
    return '';
  }
}

/** Try ImgBB; fall back to Catbox. Returns final URL or ''. */
async function uploadPosterWithFallback(imageBuffer) {
  let url = await uploadToImgbb(imageBuffer);
  if (url) { console.log('[upload] ImgBB ✓'); return url; }
  console.warn('[upload] ImgBB failed → trying Catbox…');
  url = await uploadToCatbox(imageBuffer);
  if (url) { console.log('[upload] Catbox ✓'); return url; }
  console.error('[upload] Both ImgBB and Catbox failed');
  return '';
}

// SECTION 6 — Releases: native TVMaze + TMDB  (mirrors releases_helper.py)
//
// Primary flow  : TVMaze schedule API (broadcast + web/streaming)
// Enrichment    : TMDB season details for accurate episode badge
// Matching      : DB series matched by TMDB ID → IMDB ID → Title+Year
// Result cached : in-process memory (_releasesCache) + MongoDB releases_cache
// Fallback      : if TVMaze unavailable, return whatever is in MongoDB cache
// ═══════════════════════════════════════════════════════════════════════════

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

function istDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function istTimeStr(airstamp) {
  if (!airstamp) return null;
  try {
    const ist = new Date(new Date(airstamp).getTime() + IST_OFFSET_MS);
    return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
  } catch { return null; }
}

// In-process memory cache (same-day fast path)
let _releasesCache = { date: null, db_series: [], other_series: [], top_poster: null, fetching: false };

/** TVMaze GET with optional API key. Returns parsed JSON or [] on error. */
async function tvmGet(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (TVMAZE_API_KEY) u.searchParams.set('apikey', TVMAZE_API_KEY);
  try {
    const res = await fetch(u.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'SFactory/2.0' }, timeout: 20000 });
    if (res.status === 404) return [];
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/** Fetch today's broadcast + streaming schedule from TVMaze. Deduplicated. */
async function fetchTvmazeSchedule(dateStr) {
  const [broadcast, streaming] = await Promise.allSettled([
    tvmGet('https://api.tvmaze.com/schedule',     { date: dateStr }),
    tvmGet('https://api.tvmaze.com/schedule/web', { date: dateStr }),
  ]);
  const seen = new Set(), all = [];
  for (const r of [broadcast, streaming]) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const ep of r.value) {
      if (ep.id && !seen.has(ep.id)) { seen.add(ep.id); all.push(ep); }
    }
  }
  return all;
}

/** Normalise title to a match key (lowercase, stripped punctuation). */
function titleYearKey(title, year) {
  const t = (title || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  return `${t}|${year}`;
}

function parseRating(show) {
  const r = show.rating;
  if (r && typeof r === 'object') return r.average ? parseFloat(r.average) : null;
  if (typeof r === 'number') return r;
  return null;
}

function resolvePoster(dbDoc, tvmazeShow) {
  if (dbDoc) { const p = (dbDoc.poster_url || '').trim(); if (p) return p; }
  const img = tvmazeShow.image || {};
  return img.original || img.medium || null;
}

function formatBadge(seasonNum, epNums) {
  const sStr = `S${String(seasonNum).padStart(2, '0')}`;
  if (!epNums || !epNums.length) return sStr;
  if (epNums.length > 1) {
    return `${sStr}E${String(Math.min(...epNums)).padStart(2, '0')}-E${String(Math.max(...epNums)).padStart(2, '0')}`;
  }
  return `${sStr}E${String(epNums[0]).padStart(2, '0')}`;
}

/**
 * Determine the display badge for a show's today episodes.
 * Uses TMDB season detail to detect season-finale / full-season drops.
 */
async function resolveBadge(eps, tmdbIdNum) {
  const noBadge = { season_num: null, episode_num: null, badge: 'New' };
  if (!eps || !eps.length) return noBadge;
  const seasonEps = {};
  for (const ep of eps) {
    if (ep.season && ep.number) {
      if (!seasonEps[ep.season]) seasonEps[ep.season] = [];
      seasonEps[ep.season].push(ep.number);
    }
  }
  const keys = Object.keys(seasonEps).map(Number);
  if (!keys.length) return noBadge;
  const seasonNum  = Math.max(...keys);
  const epNums     = seasonEps[seasonNum].sort((a, b) => a - b);
  const episodeNum = epNums[0];
  if (!tmdbIdNum || (!TMDB_API_KEY && !TMDB_READ_ACCESS_TOKEN)) {
    return { season_num: seasonNum, episode_num: episodeNum, badge: formatBadge(seasonNum, epNums) };
  }
  try {
    const data   = await tmdbFetch(`/tv/${tmdbIdNum}/season/${seasonNum}`, { language: 'en-US' });
    const dated  = (data.episodes || []).filter(e => e.air_date);
    if (dated.length && epNums.length >= dated.length) {
      // All dated episodes air today → show full season badge
      return { season_num: seasonNum, episode_num: episodeNum, badge: `S${String(seasonNum).padStart(2, '0')}` };
    }
  } catch (_) { /* non-fatal — fall through to formatted badge */ }
  return { season_num: seasonNum, episode_num: episodeNum, badge: formatBadge(seasonNum, epNums) };
}

/** Build today's full releases data from TVMaze + TMDB + MongoDB. */
async function buildTodayReleases(dateStr) {
  // 1. Load DB series lookup maps (TMDB ID, IMDB ID, Title+Year)
  const allDbSeries = await db.collection('series').find({}).toArray();
  const byTmdb = {}, byImdb = {}, byTitleYear = {};
  for (const s of allDbSeries) {
    const sid   = String(s._id || '');
    const title = (s.title || '').trim();
    const year  = String(s.year || '').trim();
    const imdbF = (s.imdb_id || '').trim();
    if      (imdbF.startsWith('tmdb_'))   byTmdb[imdbF.slice(5)] = [sid, s];
    else if (imdbF.startsWith('omdb_tt')) byImdb[imdbF.slice(5)] = [sid, s];
    else if (imdbF.startsWith('tt'))      byImdb[imdbF]          = [sid, s];
    if (title) byTitleYear[titleYearKey(title, year)] = [sid, s];
  }

  // 2. Fetch TVMaze schedule
  const rawEps = await fetchTvmazeSchedule(dateStr);
  if (!rawEps.length) {
    console.warn('[releases] TVMaze returned 0 episodes — API may be unavailable');
  }

  // 3. Group episodes by show ID
  const grouped = {};
  for (const ep of rawEps) {
    let show = ep.show || (ep._embedded || {}).show || {};
    const showId = show.id;
    if (!showId) continue;
    ep.show = show; // normalise
    if (!grouped[showId]) grouped[showId] = [];
    grouped[showId].push(ep);
  }

  // 4. Classify each show (parallel, capped to avoid TMDB rate-limit)
  const ALLOWED_TYPES = new Set(['Scripted', 'Animation']);
  const dbReleases = [], otherReleases = [];

  const entries = Object.entries(grouped);
  // Process in batches of 8 concurrent TMDB calls
  for (let i = 0; i < entries.length; i += 8) {
    await Promise.all(entries.slice(i, i + 8).map(async ([showId, eps]) => {
      const show     = eps[0].show || {};
      const showType = (show.type || '').trim();
      if (!ALLOWED_TYPES.has(showType)) return;

      const ext      = show.externals || {};
      const tmdbIdN  = ext.themoviedb || null;
      const imdbTt   = (ext.imdb     || '');
      const name     = show.name     || '';
      const premiered = (show.premiered || '').slice(0, 4);

      // DB match: TMDB → IMDB → Title+Year
      let match = null;
      if (tmdbIdN) match = byTmdb[String(tmdbIdN)] || null;
      if (!match && imdbTt && imdbTt.startsWith('tt')) match = byImdb[imdbTt] || null;
      if (!match && name && premiered) match = byTitleYear[titleYearKey(name, premiered)] || null;

      const isDb   = match !== null;
      const [sid, dbDoc] = match || [null, null];

      const { season_num, episode_num, badge } = await resolveBadge(eps, tmdbIdN);

      const item = {
        tvmaze_id:   parseInt(showId),
        tmdb_id:     tmdbIdN,
        series_id:   sid,
        title:       name,
        year:        premiered,
        rating:      parseRating(show),
        poster_url:  resolvePoster(dbDoc, show),
        season_num,
        episode_num,
        badge,
        air_time:    istTimeStr((eps[0] || {}).airstamp),
        is_db:       isDb,
      };

      if (isDb) dbReleases.push(item);
      else      otherReleases.push(item);
    }));
  }

  // 5. Sort by rating descending
  dbReleases.sort((a, b)    => (b.rating || 0) - (a.rating || 0));
  otherReleases.sort((a, b) => (b.rating || 0) - (a.rating || 0));

  let topPoster = null;
  for (const r of [...dbReleases, ...otherReleases]) {
    if (r.poster_url) { topPoster = r.poster_url; break; }
  }

  return { db_series: dbReleases, other_series: otherReleases, top_poster: topPoster };
}

/**
 * Return today's releases.  Precedence:
 *   1. In-process memory cache (same-day, fastest)
 *   2. MongoDB releases_cache (same-day, fast — written by bot or SFactory)
 *   3. Live fetch from TVMaze + TMDB (slowest, persisted after)
 *
 * Pass forceRefresh=true to skip caches and always re-fetch.
 */
async function getTodayReleases(forceRefresh = false) {
  const today = istDateStr();

  // 1. Memory cache
  if (!forceRefresh && _releasesCache.date === today && !_releasesCache.fetching) {
    return { date: today, db_series: _releasesCache.db_series, other_series: _releasesCache.other_series, top_poster: _releasesCache.top_poster };
  }

  // 2. MongoDB cache
  if (!forceRefresh) {
    try {
      const doc = await db.collection('releases_cache').findOne({ _id: 'data' });
      if (doc && doc.date === today) {
        _releasesCache = { date: today, db_series: doc.db_series || [], other_series: doc.other_series || [], top_poster: doc.top_poster || null, fetching: false };
        return { date: today, ..._releasesCache };
      }
    } catch (_) { /* non-fatal — fall through to live fetch */ }
  }

  // Prevent concurrent live fetches
  if (_releasesCache.fetching) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!_releasesCache.fetching) break;
    }
    return { date: today, db_series: _releasesCache.db_series, other_series: _releasesCache.other_series, top_poster: _releasesCache.top_poster };
  }

  // 3. Live fetch
  _releasesCache.fetching = true;
  try {
    const data = await buildTodayReleases(today);
    _releasesCache = { date: today, ...data, fetching: false };

    // Persist to MongoDB (also benefits SeriesBoT process on the same DB)
    try {
      await db.collection('releases_cache').replaceOne(
        { _id: 'data' },
        { _id: 'data', date: today, ...data, updated_at: new Date() },
        { upsert: true }
      );
    } catch (e) { console.warn('[releases] MongoDB persist non-fatal:', e.message); }

    console.log(`[releases] Built for ${today} — DB:${data.db_series.length} Other:${data.other_series.length}`);
    return { date: today, ...data };
  } catch (e) {
    console.error('[releases] Live fetch error:', e);
    _releasesCache.fetching = false;
    // Return whatever is in the MongoDB cache even if stale — better than empty
    try {
      const doc = await db.collection('releases_cache').findOne({ _id: 'data' });
      if (doc) return { date: doc.date || today, db_series: doc.db_series || [], other_series: doc.other_series || [], top_poster: doc.top_poster || null };
    } catch (_) {}
    return { date: today, db_series: [], other_series: [], top_poster: null };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — API Routes
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/series ────────────────────────────────────────────────────────
app.get('/api/series', async (req, res) => {
  try {
    const q     = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const filter = { published: true };
    if (q) filter.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const docs   = await db.collection('series').find(filter).sort({ created_at: -1 }).limit(limit).toArray();
    const series = docs.map(serializeSeries).filter(s => Object.keys(s.languages).length > 0);
    res.json({ ok: true, series });
  } catch (e) { console.error('GET /api/series:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/series/:id ────────────────────────────────────────────────────
app.get('/api/series/:id', async (req, res) => {
  try {
    const doc = await db.collection('series').findOne({ _id: req.params.id, published: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, series: serializeSeries(doc) });
  } catch (e) { console.error('GET /api/series/:id:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/link ──────────────────────────────────────────────────────────
app.get('/api/link', async (req, res) => {
  try {
    const { series_id, lang_id, season_id, episode_id, quality_id, type } = req.query;
    if (!series_id || !lang_id || !season_id || !quality_id)
      return res.status(400).json({ ok: false, error: 'Missing required params' });
    const doc = await db.collection('series').findOne({ _id: series_id, published: true });
    if (!doc)    return res.status(404).json({ ok: false, error: 'Series not found' });
    const lang   = (doc.languages || {})[lang_id];
    if (!lang)   return res.status(404).json({ ok: false, error: 'Language not found' });
    const season = (lang.seasons || {})[season_id];
    if (!season) return res.status(404).json({ ok: false, error: 'Season not found' });
    let startParam;
    if (type === 'file' && episode_id) {
      const episode = (season.episodes || {})[episode_id];
      if (!episode) return res.status(404).json({ ok: false, error: 'Episode not found' });
      const eq = (episode.qualities || {})[quality_id];
      if (!eq || !eq.msg_id || !eq.published) return res.status(404).json({ ok: false, error: 'Quality not available' });
      if (eq.file_link) { const m = eq.file_link.match(/[?&]start=([^&]+)/); if (m) startParam = m[1]; }
      if (!startParam) startParam = `get_${String(eq.db_channel_id || '').replace(/^-100/, '')}_${eq.msg_id}_${eq.msg_id}`;
    } else {
      const q = (season.qualities || {})[quality_id];
      if (!q || !q.published) return res.status(404).json({ ok: false, error: 'Quality not available' });
      if (q.batch_link) {
        const m = q.batch_link.match(/[?&]start=([^&]+)/);
        startParam = m ? m[1] : q.batch_link;
      } else if (q.first_msg_id && q.last_msg_id) {
        startParam = `get_${String(q.db_channel_id || '').replace(/^-100/, '')}_${q.first_msg_id}_${q.last_msg_id}`;
      } else {
        return res.status(404).json({ ok: false, error: 'Batch not available yet' });
      }
    }
    res.json({ ok: true, bot_link: `https://t.me/${BOT_USERNAME}?start=${startParam}` });
  } catch (e) { console.error('GET /api/link:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/config ────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => res.json({ ok: true, bot_username: BOT_USERNAME }));

// ── GET /api/ads/active ────────────────────────────────────────────────────
app.get('/api/ads/active', async (req, res) => {
  try {
    const now  = new Date();
    const docs = await db.collection('ads').find({}).toArray();
    const ads  = docs
      .filter(d => !d.expires_at || new Date(d.expires_at) > now)
      .map(d => ({ slot: d._id, type: d.type, file_url: d.file_url, click_url: d.click_url || null }));
    res.json({ ok: true, ads });
  } catch (e) { console.error('GET /api/ads/active:', e); res.json({ ok: true, ads: [] }); }
});

// ── GET /api/latest ────────────────────────────────────────────────────────
app.get('/api/latest', async (req, res) => {
  try {
    const doc     = await db.collection('recent_list').findOne({ _id: 'entries' });
    const entries = (doc && doc.items) ? doc.items : [];
    res.json({ ok: true, entries });
  } catch (e) { console.error('GET /api/latest:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/search/latest ─────────────────────────────────────────────────
app.get('/api/search/latest', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, entries: [] });
  try {
    const lq        = q.toLowerCase();
    const recentDoc = await db.collection('recent_list').findOne({ _id: 'entries' });
    const allRecent = (recentDoc && recentDoc.items) ? recentDoc.items : [];
    const recentMatches = allRecent.filter(e =>
      (e.title || '').toLowerCase().includes(lq) ||
      (e.year  || '').toLowerCase().includes(lq) ||
      (e.info_str || '').toLowerCase().includes(lq)
    );
    const recentIds = new Set(recentMatches.map(e => e.series_id));
    const safeQ     = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dbDocs    = await db.collection('series').find({ published: true, title: { $regex: safeQ, $options: 'i' } }).sort({ created_at: -1 }).limit(30).toArray();
    const extra = [];
    for (const series of dbDocs) {
      const sid = String(series._id || '');
      if (recentIds.has(sid)) continue;
      const info = _buildInfoStr(series);
      if (!info.info_str) continue;
      const ca = series.created_at;
      extra.push({
        series_id: sid, title: series.title || 'Unknown',
        info_str: info.info_str, year: String(series.year || ''),
        poster_url: series.poster_url || '', is_season: info.is_season,
        season_num: info.season_num, episode_num: info.episode_num,
        batch_link: info.batch_link, file_link: info.file_link, quality: info.quality,
        added_at: ca instanceof Date ? ca.toISOString() : String(ca || ''),
      });
    }
    res.json({ ok: true, entries: [...recentMatches, ...extra] });
  } catch (e) { console.error('GET /api/search/latest:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/requests ──────────────────────────────────────────────────────
app.get('/api/requests', async (req, res) => {
  try {
    const docs = await db.collection('series_requests').find({ uploaded: false }).sort({ request_count: -1 }).limit(100).toArray();
    const safe = docs.map(item => {
      const out = { ...item }; delete out._id;
      if (out.created_at instanceof Date)        out.created_at        = out.created_at.toISOString();
      if (out.latest_request_at instanceof Date) out.latest_request_at = out.latest_request_at.toISOString();
      return out;
    });
    res.json({ ok: true, requests: safe });
  } catch (e) { console.error('GET /api/requests:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/search/request ────────────────────────────────────────────────
app.get('/api/search/request', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, requests: [] });
  try {
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const docs  = await db.collection('series_requests').find({ uploaded: false, title: { $regex: safeQ, $options: 'i' } }).sort({ request_count: -1 }).limit(30).toArray();
    const safe  = docs.map(item => {
      const out = { ...item }; delete out._id;
      if (out.created_at instanceof Date)        out.created_at        = out.created_at.toISOString();
      if (out.latest_request_at instanceof Date) out.latest_request_at = out.latest_request_at.toISOString();
      return out;
    });
    res.json({ ok: true, requests: safe });
  } catch (e) { console.error('GET /api/search/request:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── POST /api/request/add ──────────────────────────────────────────────────
app.post('/api/request/add', async (req, res) => {
  const body       = req.body || {};
  const tmdb_id    = String(body.tmdb_id    || '').trim();
  const title      = String(body.title      || '').trim();
  const year       = String(body.year       || '').trim();
  const poster_url = String(body.poster_url || '').trim();
  if (!tmdb_id || !title)
    return res.status(400).json({ ok: false, error: 'tmdb_id and title are required' });

  let user_id = parseInt(body.user_id || '0') || 0;
  const requester_ip = (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.headers['x-real-ip'] || '').trim() ||
    (req.socket && req.socket.remoteAddress) || 'unknown'
  );
  const requester_key = user_id ? String(user_id) : `ip:${requester_ip}`;

  try {
    // Duplicate check
    let alreadyRequested = false;
    if (user_id) {
      const uDoc = await db.collection('request_users').findOne({ user_id });
      if (uDoc) alreadyRequested = (uDoc.requests || []).some(r => r.tmdb_id === tmdb_id);
    }
    if (!alreadyRequested && requester_ip && requester_ip !== 'unknown') {
      const ipDoc = await db.collection('request_users').findOne({ requester_ip });
      if (ipDoc) alreadyRequested = (ipDoc.requests || []).some(r => r.tmdb_id === tmdb_id);
    }
    if (alreadyRequested) {
      const doc = await db.collection('series_requests').findOne({ tmdb_id });
      return res.json({ ok: false, error: 'already_requested', message: 'You have already requested this series.', request_count: doc ? (doc.request_count || 1) : 1 });
    }
    // Weekly limit
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let weeklyCount = 0;
    if (user_id) {
      const uDoc = await db.collection('request_users').findOne({ user_id });
      if (uDoc) weeklyCount = (uDoc.requests || []).filter(r => r.ts && new Date(r.ts) >= cutoff).length;
    } else if (requester_ip && requester_ip !== 'unknown') {
      const ipDoc = await db.collection('request_users').findOne({ requester_ip });
      if (ipDoc) weeklyCount = (ipDoc.requests || []).filter(r => r.ts && new Date(r.ts) >= cutoff).length;
    }
    if (weeklyCount >= MAX_WEEKLY_REQUESTS)
      return res.json({ ok: false, error: 'weekly_limit', message: `Weekly request limit reached (${MAX_WEEKLY_REQUESTS} requests per week)` });
    // Upsert
    const now      = new Date();
    const existing = await db.collection('series_requests').findOne({ tmdb_id });
    let resultDoc;
    if (existing) {
      await db.collection('series_requests').updateOne(
        { tmdb_id },
        { $inc: { request_count: 1 }, $set: { latest_request_at: now }, $addToSet: { requested_by: user_id, requester_keys: requester_key, requester_ips: requester_ip } }
      );
      resultDoc = await db.collection('series_requests').findOne({ tmdb_id });
    } else {
      const newDoc = { tmdb_id, title, year, poster_url, request_count: 1, requested_by: [user_id], requester_keys: [requester_key], requester_ips: requester_ip ? [requester_ip] : [], uploaded: false, created_at: now, latest_request_at: now };
      await db.collection('series_requests').insertOne(newDoc);
      resultDoc = newDoc;
    }
    // Record in request_users
    const entry = { tmdb_id, title, ts: now };
    if (user_id) {
      await db.collection('request_users').updateOne({ user_id }, { $push: { requests: { $each: [entry], $slice: -50 } }, $set: { requester_ip } }, { upsert: true });
    } else if (requester_ip && requester_ip !== 'unknown') {
      await db.collection('request_users').updateOne({ requester_ip }, { $push: { requests: { $each: [entry], $slice: -50 } } }, { upsert: true });
    }
    res.json({ ok: true, message: `✅ Request submitted for "${title}"!`, request_count: resultDoc ? (resultDoc.request_count || 1) : 1 });
  } catch (e) { console.error('POST /api/request/add:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/file/get ──────────────────────────────────────────────────────
app.get('/api/file/get', async (req, res) => {
  const series_id = (req.query.series_id || '').trim();
  const link_type = req.query.link_type || 'batch';
  if (!series_id) return res.status(400).json({ ok: false, error: 'series_id required' });
  try {
    const recentDoc = await db.collection('recent_list').findOne({ _id: 'entries' });
    const entries   = (recentDoc && recentDoc.items) ? recentDoc.items : [];
    const entry     = entries.find(e => e.series_id === series_id) || null;
    let link = null;
    if (entry) link = link_type === 'file' ? (entry.file_link || entry.batch_link) : (entry.batch_link || entry.file_link);
    if (!link) {
      const series = await db.collection('series').findOne({ _id: series_id, published: true });
      if (series) {
        const info = _buildInfoStr(series);
        link = link_type === 'file' ? (info.file_link || info.batch_link) : (info.batch_link || info.file_link);
      }
    }
    if (!link) return res.status(404).json({ ok: false, error: 'No links available for this entry' });
    res.json({ ok: true, bot_link: link });
  } catch (e) { console.error('GET /api/file/get:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/tmdb/search  (TV-only, filters already-added series) ──────────
app.get('/api/tmdb/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  if (!TMDB_API_KEY && !TMDB_READ_ACCESS_TOKEN) {
    console.warn('/api/tmdb/search: no TMDB credentials');
    return res.json({ results: [] });
  }
  try {
    const titleDocs      = await db.collection('series').find({}, { projection: { title: 1 } }).toArray();
    const existingTitles = new Set(titleDocs.map(d => (d.title || '').toLowerCase()));
    const data = await tmdbFetch('/search/tv', { query: q, language: 'en-US', page: '1' });
    const safe = [];
    for (const r of (data.results || [])) {
      const title = r.name || r.title || '';
      if (!title || !r.first_air_date) continue;
      if (existingTitles.has(title.toLowerCase())) continue;
      safe.push({ id: r.id, name: title, first_air_date: r.first_air_date || '', poster_path: r.poster_path, genre_ids: r.genre_ids || [] });
      if (safe.length >= 10) break;
    }
    res.json({ results: safe });
  } catch (e) { console.error('GET /api/tmdb/search:', e); res.json({ results: [] }); }
});

// ── GET /api/releases  (native TVMaze + TMDB, MongoDB cache layer) ─────────
app.get('/api/releases', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const data  = await getTodayReleases(force);
    res.json({ ok: true, date: data.date || '', db_series: data.db_series || [], other_series: data.other_series || [], top_poster: data.top_poster || null });
  } catch (e) { console.error('GET /api/releases:', e); res.status(500).json({ ok: false, error: 'Internal server error' }); }
});

// ── GET /api/poster/images  (TMDB backdrops + logos for the poster editor) ──
app.get('/api/poster/images', async (req, res) => {
  const series_id = (req.query.series_id || '').trim();
  if (!series_id) return res.status(400).json({ error: 'Missing series_id' });
  try {
    const series = await db.collection('series').findOne({ _id: series_id });
    if (!series) return res.status(404).json({ error: 'Series not found' });

    const tmdb_id = series.tmdb_id;
    const title   = series.title || '';
    if (!tmdb_id) return res.json({ title, backdrops: [], logos: [] });

    const imgRes  = await fetch(tmdbUrl(`/tv/${tmdb_id}/images`, { include_image_language: 'en,null' }), { headers: tmdbHeaders() });
    if (!imgRes.ok) return res.json({ title, backdrops: [], logos: [] });
    const imgData = await imgRes.json();

    const BASE = 'https://image.tmdb.org/t/p/';
    const backdrops = (imgData.backdrops || []).slice(0, 20).map(b => ({
      url:    BASE + 'w780'  + b.file_path,
      url_hd: BASE + 'w1280' + b.file_path,
    }));
    const logos = (imgData.logos || []).slice(0, 15).map(l => ({
      url:    BASE + 'w300' + l.file_path,
      url_hd: BASE + 'w500' + l.file_path,
    }));

    res.json({ title, backdrops, logos });
  } catch (e) { console.error('GET /api/poster/images:', e); res.status(500).json({ error: String(e) }); }
});

// ── POST /api/poster/save  (receive rendered image → upload → MongoDB) ──────
//
// Body JSON:
//   series_id   (string, required)
//   image_data  (string, required) — base64 JPEG rendered by the browser canvas
//
app.post('/api/poster/save', async (req, res) => {
  const body       = req.body || {};
  const series_id  = (body.series_id  || '').trim();
  const image_data = (body.image_data || '').trim();

  if (!series_id)  return res.status(400).json({ error: 'series_id is required' });
  if (!image_data) return res.status(400).json({ error: 'image_data is required' });

  try {
    const series = await db.collection('series').findOne({ _id: series_id });
    if (!series) return res.status(404).json({ error: `Series not found: ${series_id}` });
  } catch (e) {
    return res.status(500).json({ error: 'Database error: ' + e.message });
  }

  // Strip data URI prefix if present
  const base64 = image_data.replace(/^data:image\/\w+;base64,/, '');
  const imageBuffer = Buffer.from(base64, 'base64');

  let poster_url;
  try {
    poster_url = await uploadPosterWithFallback(imageBuffer);
    if (!poster_url) return res.status(500).json({ error: 'All upload services failed. Check IMGBB_API_KEY / CATBOX_API_KEY.' });
  } catch (e) {
    return res.status(500).json({ error: 'Upload error: ' + e.message });
  }

  try {
    await db.collection('series').updateOne(
      { _id: series_id },
      { $set: { poster_url, poster_file_id: null } }
    );
  } catch (e) {
    return res.status(500).json({ error: 'DB save failed: ' + e.message });
  }

  console.log(`[poster/save] ${series_id} → ${poster_url}`);
  res.json({ success: true, poster_url, series_id });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — Serve webapp HTML pages
// ═══════════════════════════════════════════════════════════════════════════

const WEBAPP_DIR = path.join(__dirname, '../webapp');

function serveWebapp(filename) {
  return (req, res) => {
    res.sendFile(path.join(WEBAPP_DIR, filename), err => {
      if (err) res.status(404).send(`${filename} not found in webapp directory`);
    });
  };
}

app.get('/latest',   serveWebapp('latest.html'));
app.get('/request',  serveWebapp('request.html'));
app.get('/releases', serveWebapp('releases.html'));
app.get('/poster',   serveWebapp('poster_editor.html'));

// ─── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — Start
// ═══════════════════════════════════════════════════════════════════════════

if (process.env.VERCEL) {
  // Vercel serverless: connect on first request
  const origHandle = app.handle.bind(app);
  app.handle = async (req, res) => {
    if (!db) await connectDB();
    origHandle(req, res);
  };
  module.exports = app;
} else {
  (async () => {
    try {
      await connectDB();
      app.listen(PORT, () => console.log(`🚀  SFactory running on http://localhost:${PORT}`));
    } catch (e) {
      console.error('Startup error:', e);
      process.exit(1);
    }
  })();
}
