# StockOne Portfolio Analyzer 🚀

[![Vite](https://img.shields.io/badge/Vite-6.x-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![React](https://img.shields.io/badge/React-18.x-61DAFB?logo=react&logoColor=white)](https://reactjs.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.x-38B2AC?logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![Capacitor](https://img.shields.io/badge/Capacitor-8.x-119EFF?logo=capacitor&logoColor=white)](https://capacitorjs.com/)

StockOne is a professional-grade stock portfolio analyzer and management suite built with **React**, **Vite**, and **Capacitor**. It features deep integration with the **Zerodha Kite Connect API** for real-time portfolio synchronization, advanced backtesting engines, and a native Android wrapper for mobile monitoring.

---

## ✨ Key Features

### 📊 Comprehensive Dashboard
- **Portfolio Pulse:** Real-time P&L tracking, allocation charts, and performance metrics.
- **Market Movers:** Quick view of top indices (NIFTY 50, BANK NIFTY, etc.) and market trends.
- **Sector Rotation:** Analyze your portfolio's exposure across different sectors to ensure diversification.

### 🧪 Backtesting & Analysis Lab
- **SMA Strategy Scanner:** Run backtests on your holdings using configurable Simple Moving Average (SMA) crossover rules.
- **Excel Import:** Batch test symbols by importing data from Excel files.
- **Strategy Comparison:** Compare your strategy returns against a "Buy & Hold" benchmark (e.g., NIFTY 50).
- **AI Summaries:** Integration with **Ollama** (Llama 3.2) for automated, AI-generated performance summaries.

### 💼 Portfolio Workspace
- **Broker Sync:** One-click synchronization with your **Zerodha** holdings and positions.
- **Smart Detail View:** Deep dive into individual stocks with valuation snapshots (PE, PEG, PB), growth metrics, and thesis notes.
- **Risk Analysis:** Concentration checks, beta tracking, and rebalancing suggestions to manage downside risk.

### 🤖 Remote Monitoring (Telegram Bot)
- **Built-in Bot:** Monitor your portfolio via Telegram with commands like `/summary`, `/positions`, `/quote`, and `/news`.
- **Alerts:** Automated alerts for 52-week highs and critical historical price levels.

---

## 🛠️ Tech Stack

- **Frontend:** React 18, Vite, Tailwind CSS, Lucide Icons, Recharts, TanStack Query.
- **Backend Bridge:** Node.js (Custom HTTP/API proxy for Zerodha & Telegram).
- **Mobile:** Capacitor 8 (Android).
- **Database/Auth:** Firebase (Authentication), Local Browser Storage (IndexedDB/LocalStorage).
- **Data Providers:** Zerodha Kite Connect, Financial Modeling Prep (FMP), Yahoo Finance.
- **AI/ML:** Python (VectorBT for advanced backtesting), Ollama (Local LLM).

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** (LTS version)
- **Python 3.x** (for advanced backtesting)
- **Kite Connect API Key** (from Zerodha)
- **Firebase Project** (for Auth)

### 1. Installation
```bash
git clone https://github.com/BARICM85/Stockone-android.git
cd Stockone-android
npm install
```

### 2. Configuration
Copy the environment template and fill in your API credentials:
```bash
cp .env.example .env
```

| Variable | Description |
| :--- | :--- |
| `VITE_API_BASE_URL` | Set to `http://localhost:8000` for local dev. |
| `ZERODHA_API_KEY` | Your Kite Connect API Key. |
| `FMP_API_KEY` | Financial Modeling Prep key for fundamentals. |
| `TELEGRAM_BOT_TOKEN` | Your Telegram Bot token from @BotFather. |
| `OLLAMA_BASE_URL` | Optional: URL for your local Ollama instance. |

### 3. Running the App
Start the frontend and backend bridge in separate terminals:

**Terminal 1 (Frontend):**
```bash
npm run dev
```

**Terminal 2 (Backend):**
```bash
npm run dev:server
```

---

## 📱 Mobile (Android)

Build and sync the Android project using Capacitor:
```bash
npm run android:sync   # Build web app and sync assets
npm run android:open   # Open in Android Studio
npm run android:build  # Generate a debug APK
```

---

## 🚢 Deployment

### Frontend (Vercel)
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Routing:** Handled via `vercel.json` for SPA support.

### Backend (Render)
- **Build Command:** `npm install`
- **Start Command:** `npm run start:server`
- **Service Type:** Web Service (Node.js).

---

## 📄 License
This project is for educational and personal use. Please refer to the [Kite Connect Terms](https://kite.trade/terms) for API usage policies.

---
*Created with ❤️ for the Indian Stock Market.*
