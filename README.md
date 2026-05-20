# stockone Portfolio Analyzer

Standalone React + Vite stock portfolio analyzing app with Firebase Google login and Zerodha broker sync support.

## Features

- Dashboard with allocation, P&L, market movers, portfolio pulse, and watchlist triggers
- Dashboard backtest lane that runs each holding one by one and compares strategy return against buy-and-hold
- Custom testing lane that imports symbols from Excel and scans three SMA rules with `<`, `>`, or `=`
- Portfolio workspace with manual entry, CSV/JSON import, JSON export, search, and Zerodha holdings sync
- Stock detail view with valuation snapshot, thesis notes, scenario planning, and generated analysis
- Risk lab with concentration checks, sector exposure, beta view, and rebalance suggestions
- Watchlist with target-price tracking and one-click move into portfolio
- Google sign-in using Firebase Authentication
- Local browser storage for portfolio and watchlist data
- Telegram Bot for remote portfolio monitoring (summary, positions, quotes, news)

## Run locally

1. Install dependencies

```bash
npm install
```

2. Copy the environment template

```bash
copy .env.example .env
```

3. Fill in your Firebase, Zerodha, backtest, Ollama, and optional Firecrawl keys in `.env`

4. Start the frontend

```bash
npm run dev
```

5. Start the Zerodha backend bridge in a second terminal

```bash
npm run dev:server
```

## Separate local CMD mode and hosted web mode

The app now keeps local and hosted data separate automatically.

- Local CMD/browser mode uses storage namespace: `local`
- Hosted website mode uses storage namespace: `web`

That means:

- your local portfolio and watchlist stay separate from the hosted website portfolio
- chart layouts and option-chain preferences are also stored separately

### Local CMD mode

Use:

```bash
npm run dev:local
npm run dev:server
```

Reference env template:

- [.env.local.example](./.env.local.example)

### Hosted web mode

Use:

```bash
npm run build:web
```

Reference env template:

- [.env.web.example](./.env.web.example)

For hosting:

- frontend on Vercel
- backend on Render

## Firebase Google login setup

- Set `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID`
- In Firebase Console, enable Google as a sign-in provider in Authentication
- Keep your frontend running on the allowed local origin `http://localhost:5178`

## Zerodha setup

- Set `VITE_API_BASE_URL=http://localhost:8000`
- Set `ZERODHA_API_KEY` and `ZERODHA_API_SECRET`
- Whitelist `http://localhost:8000/api/zerodha/callback` as the redirect URL in your Kite Connect app
- Keep the backend running before clicking Connect Zerodha in the app

## Telegram Bot setup

The backend includes a built-in Telegram bot for monitoring your portfolio on the go.

1. Create a bot using [@BotFather](https://t.me/botfather) and get the **Bot Token**.
2. Set `TELEGRAM_BOT_TOKEN` in your `.env`.
3. Start the server, then send `/start` to your bot to get your **Chat ID**.
4. Set `TELEGRAM_CHAT_ID` in your `.env` to restrict the bot to your account only.
5. Restart the server.

**Available Commands:**

- `/summary` - Get portfolio P&L summary
- `/positions` - Get current open positions with live P&L
- `/quote SYMBOL` - Get live price for any stock (e.g., `/quote RELIANCE`)
- `/news SYMBOL` - Get latest 5 news items for a symbol
- `/help` - List all available commands

## Backtesting and local AI

The dashboard now includes a per-stock backtest section and a custom testing section. The custom lane can import symbols from Excel and run a three-SMA scan using configurable `<`, `>`, or `=` rules.

Useful backend env vars:

- `BACKTEST_RANGE=2y`
- `BACKTEST_FAST_WINDOW=20`
- `BACKTEST_SLOW_WINDOW=50`
- `BACKTEST_INITIAL_CASH=100000`
- `BACKTEST_COMMISSION_BPS=0`
- `BACKTEST_BENCHMARK_SYMBOL=^NSEI`
- `BACKTEST_ENGINE=vectorbt` for local Python VectorBT runs, or `js` for the built-in fallback
- `PYTHON_BIN=python3` or your VectorBT-enabled interpreter path
- `OLLAMA_BASE_URL=http://127.0.0.1:11434` for local AI summaries
- `OLLAMA_MODEL=llama3.2:3b`
- `FIRECRAWL_API_BASE_URL=http://localhost:3002` if you run Firecrawl locally
- `FIRECRAWL_API_KEY=` if your Firecrawl setup requires one

## Android app

This project now includes a Capacitor Android wrapper in [android](./android).

Useful commands:

```bash
npm run android:sync
npm run android:open
npm run android:build
```

- `android:sync` builds the web app and copies the latest web assets into the Android project
- `android:open` opens the native Android project in Android Studio
- `android:build` creates a debug APK using the bundled web app

### Android Google sign-in setup

To make Google sign-in work inside the Android app, the Firebase Android app setup must also exist.

1. In Firebase Console, add an Android app with package name:

```text
com.bariyaone.tickertap
```

2. Register your debug/release SHA fingerprints in Firebase Authentication for that Android app.

3. Download `google-services.json` from Firebase.

4. Place it here locally:

```text
android/app/google-services.json
```

Without that file, the Android app can build, but native Google sign-in will fail.

### Android release signing later

This project is prepared for a future signed release build.

1. Create your release keystore:

```bash
keytool -genkeypair -v -keystore tickertap-release.keystore -alias tickertap -keyalg RSA -keysize 2048 -validity 10000
```

2. Put the keystore somewhere safe outside Git, or inside `android/app` locally only.

3. Copy:

```bash
copy android\keystore.properties.example android\keystore.properties
```

4. Fill in your real values in `android/keystore.properties`

5. The Android Gradle config will automatically use release signing when `android/keystore.properties` exists.

## Notes

- Sample holdings and watchlist items are seeded automatically on first load
- Broker sync merges fetched holdings into the local portfolio by symbol
- Spreadsheet imports should be converted to CSV before upload

## Deploy as a real website

Recommended setup:

- Frontend: Vercel Hobby
- Backend bridge: Render Free Web Service

### 1. Push this project to GitHub

Create a GitHub repo and push the whole project folder.

### 2. Deploy the frontend to Vercel

This project already includes [vercel.json](./vercel.json) for SPA routing.

- Import the GitHub repo into Vercel
- Framework preset: `Vite`
- Build command: `npm run build`
- Output directory: `dist`
- Add frontend env vars:
  - `VITE_FIREBASE_API_KEY`
  - `VITE_FIREBASE_AUTH_DOMAIN`
  - `VITE_FIREBASE_PROJECT_ID`
  - `VITE_FIREBASE_APP_ID`
  - `VITE_API_BASE_URL=https://YOUR-RENDER-BACKEND.onrender.com`

### 3. Deploy the backend to Render

This project already includes [render.yaml](./render.yaml).

- In Render, create a new `Web Service` from the same GitHub repo
- Root directory: project root
- Build command: `npm install`
- Start command: `npm run start:server`
- Add backend env vars:
  - `ZERODHA_API_KEY`
  - `ZERODHA_API_SECRET`
  - `FMP_API_KEY`
  - `ZERODHA_REDIRECT_URI=https://YOUR-RENDER-BACKEND.onrender.com/api/zerodha/callback`
  - `ZERODHA_FRONTEND_URL=https://YOUR-VERCEL-FRONTEND.vercel.app`
  - `ZERODHA_SESSION_PATH=server/.zerodha-session.json`
  - `ZERODHA_SERVER_PORT=10000`
  - `FMP_API_BASE_URL=https://financialmodelingprep.com/stable`
  - `BACKTEST_RANGE=2y`
  - `BACKTEST_FAST_WINDOW=20`
  - `BACKTEST_SLOW_WINDOW=50`
  - `BACKTEST_INITIAL_CASH=100000`
  - `BACKTEST_COMMISSION_BPS=0`
  - `BACKTEST_BENCHMARK_SYMBOL=^NSEI`

`FMP_API_KEY` powers the stock fundamentals and news-backed fields on the stock detail page:

- Earnings Growth YoY / QoQ
- Revenue Growth
- ROE / ROCE
- Debt-to-Equity
- Free Cash Flow
- PEG / PB / EV/EBITDA
- News Risk
- Corporate Actions

Without `FMP_API_KEY`, the stock page still works, but those items remain `Unavailable`.

The backend now stores the Zerodha session only in `ZERODHA_SESSION_PATH`, so no Postgres database is required for broker login persistence.

### 4. Update provider settings

- Firebase Authentication authorized domains:
  - your Vercel domain
- Zerodha Kite redirect URL:
  - `https://YOUR-RENDER-BACKEND.onrender.com/api/zerodha/callback`
- Zerodha postback URL:
  - `https://YOUR-RENDER-BACKEND.onrender.com/api/zerodha/postback`

### 5. Important free-hosting note

Render Free web services spin down after 15 minutes of inactivity and may take up to about a minute to wake up again. That means broker or chart API calls can feel slow on the first request after idle.
