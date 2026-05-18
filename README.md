# Series Vault — Telegram Web App

A production-ready Telegram Web App for your Series Bot.  
Users search your MongoDB series catalogue and get Telegram deep-links to receive files directly from the bot.

---

## Project Structure

```
seriesbot-webapp/
├── backend/
│   ├── server.js          # Express API + static file server
│   ├── package.json
│   ├── .env.example       # ← copy to .env and fill in
│   └── .gitignore
├── frontend/
│   └── public/
│       └── index.html     # Single-file Telegram Web App
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## Quick Start (Local)

### 1. Configure environment

```bash
cd backend
cp .env.example .env
```

Edit `.env`:

```env
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster0.xxxx.mongodb.net/?appName=Cluster0
DB_NAME=Cluster0
BOT_USERNAME=YourSeriesBot
PORT=3000
```

> `MONGODB_URI` and `DB_NAME` are exactly the same values as `DATABASE_URI` / `DATABASE_NAME` in your bot's `info.py`.

### 2. Install & run

```bash
cd backend
npm install
npm start
```

Open `http://localhost:3000` in your browser.

---

## Deploy on Koyeb / Railway / Render

1. Push the whole `seriesbot-webapp/` folder to a GitHub repo.
2. Set environment variables in the platform dashboard (same as `.env`).
3. Build command: `cd backend && npm install`  
   Start command: `node backend/server.js`
4. The static frontend is served automatically by the backend.

### With Docker

```bash
docker compose up --build
```

---

## Integrate with your existing bot

### Register the Web App URL

In `info.py` / environment variables, set:

```python
WEBAPP_URL = 'https://your-webapp-url.koyeb.app'
```

### Add a menu button in `bot.py`

```python
from pyrogram.types import MenuButton, WebAppInfo

await client.set_bot_menu_button(
    menu_button=MenuButton(
        type="web_app",
        text="📺 Browse Series",
        web_app=WebAppInfo(url=WEBAPP_URL)
    )
)
```

Or send it as an inline button:

```python
from pyrogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

btn = InlineKeyboardButton(
    "📺 Browse Series",
    web_app=WebAppInfo(url="https://your-webapp-url.koyeb.app")
)
```

---

## How it works

### Data flow

```
User opens Web App
   → Search/browse series (GET /api/series?q=...)
   → Tap series card → slide-up detail panel
   → Select: Language → Season → Episode (if any) → Quality
   → Tap "Get File" / "Get Files"
   → GET /api/link → returns t.me deep-link
   → tg.openTelegramLink() → user redirected to bot PM
   → Bot delivers file(s)
```

### Single episode vs batch logic

| Condition | Flow | Button |
|-----------|------|--------|
| Season has `episodes` with published qualities | Show episode selector → quality selector | **Get File** |
| Season has only season-level `qualities` (no episodes) | Show quality selector directly | **Get Files** |

### Deep-link formats

The backend reads the MongoDB document and builds:

- **Single file**: `https://t.me/YourBot?start=file_{msg_id}_{channel_id}`
- **Batch**: `https://t.me/YourBot?start=batch_{first_msg_id}_{last_msg_id}_{channel_id}`

These match what your bot already handles via `start=` parameter.

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/series` | GET | List published series. Query: `?q=` for search, `?limit=` |
| `/api/series/:id` | GET | Single series detail |
| `/api/link` | GET | Build Telegram deep-link for selected file/batch |
| `/api/config` | GET | Returns `bot_username` for client |

---

## MongoDB Schema (reference)

Your bot uses this schema in the `series` collection:

```
series {
  _id: string          (series ID)
  title: string
  year: string
  genre: string
  rating: string
  poster_url: string
  published: bool      ← only published=true are shown
  languages: {
    [lang_id]: {
      name: string
      seasons: {
        [season_id]: {
          name: string
          qualities: {           ← batch mode (no episodes)
            [quality_id]: {
              name: string
              first_msg_id: int
              last_msg_id: int
              db_channel_id: int
              batch_link: string
              published: bool
            }
          }
          episodes: {            ← single-file mode
            [episode_id]: {
              name: string
              qualities: {
                [quality_id]: {
                  name: string
                  msg_id: int
                  db_channel_id: int
                  published: bool
                }
              }
            }
          }
        }
      }
    }
  }
}
```

---

## UI Features

- **OTT dark theme** — deep navy/purple with magenta/gold neon accents
- **Glassmorphism** panel with poster hero image
- **Real-time search** with debounce (320ms)
- **Default selection** — English language & Season 1 pre-selected
- **Dynamic selectors** — only shows what exists in DB
- **Episode vs Batch** — automatically switches flow based on DB content
- **Swipe-to-close** panel on mobile
- **Telegram Back Button** integration
- **Toast notifications** for errors and success
- **Skeleton loaders** during fetch
- **Mobile-first** layout optimised for Telegram in-app browser
