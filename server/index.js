import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf8');
  return content.split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return acc;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    acc[key] = value.replace(/^['"]|['"]$/g, '');
    return acc;
  }, {});
}

const projectRoot = resolve(__dirname, '..');
const env = {
  ...loadEnvFile(resolve(projectRoot, '.env')),
  ...loadEnvFile(resolve(projectRoot, '.env.local')),
  ...process.env,
};

const PORT = Number(env.PORT || env.ZERODHA_SERVER_PORT || 8000);
const API_KEY = env.ZERODHA_API_KEY || '';
const API_SECRET = env.ZERODHA_API_SECRET || '';
const FRONTEND_URL = env.ZERODHA_FRONTEND_URL || 'http://localhost:5173';
const REDIRECT_URI = env.ZERODHA_REDIRECT_URI || `http://localhost:${PORT}/api/zerodha/callback`;
const SESSION_PATH = resolve(projectRoot, env.ZERODHA_SESSION_PATH || 'server/.zerodha-session.json');
const AUTH_CONTEXT_PATH = resolve(projectRoot, env.ZERODHA_AUTH_CONTEXT_PATH || 'server/.zerodha-auth-context.json');
const NATIVE_REDIRECT_URL = env.ZERODHA_NATIVE_REDIRECT_URL || 'stockone://zerodha/callback';
const FMP_API_KEY = env.FMP_API_KEY || '';
const FMP_API_BASE_URL = env.FMP_API_BASE_URL || 'https://financialmodelingprep.com/stable';
const OLLAMA_BASE_URL = env.OLLAMA_BASE_URL || '';
const OLLAMA_MODEL = env.OLLAMA_MODEL || 'llama3.2:3b';
const FIRECRAWL_API_BASE_URL = env.FIRECRAWL_API_BASE_URL || '';
const FIRECRAWL_API_KEY = env.FIRECRAWL_API_KEY || '';
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || '';
const ALERT_MONITOR_INTERVAL = 15 * 60 * 1000; // 15 minutes
const sentAlertsCache = new Set();

async function checkPortfolioAlerts() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    const session = await readSession();
    if (!session?.access_token) return;

    const data = await kiteRequest('/portfolio/holdings');
    const holdings = data?.data || [];
    if (!holdings.length) return;

    for (const holding of holdings) {
      try {
        const symbol = holding.tradingsymbol;
        const exchange = holding.exchange || 'NSE';
        
        // Condition 1: 52-Week High
        const profile = await fetchFmp('profile', { symbol });
        const yearHigh = profile?.[0]?.yearHigh;
        const currentPrice = holding.last_price || profile?.[0]?.price;

        if (yearHigh && currentPrice >= yearHigh) {
          const alertKey = `${symbol}-52w-high-${Math.floor(Date.now() / (24 * 60 * 60 * 1000))}`;
          if (!sentAlertsCache.has(alertKey)) {
            await sendTelegramMessage(`<b>🚀 52-Week High Alert</b>\n\nStock: <b>${symbol}</b>\nCurrent Price: ${currentPrice}\n52W High: ${yearHigh}\n\nSymbol is testing its annual peaks!`);
            sentAlertsCache.add(alertKey);
          }
        }

        // Condition 2: Price on 26/09/2025 (Reference Date)
        // We use 2025 because 2026 is future in this context (Today is April 30, 2026)
        const refDate = '2025-09-26';
        const history = await fetchMarketHistory(symbol, '1y', '1d', exchange);
        const refPoint = (history?.points || []).find(p => p.date === refDate);
        const refHigh = refPoint?.high || refPoint?.close;

        if (refHigh && currentPrice >= refHigh) {
          const alertKey = `${symbol}-ref-date-${refDate}-${Math.floor(Date.now() / (24 * 60 * 60 * 1000))}`;
          if (!sentAlertsCache.has(alertKey)) {
            await sendTelegramMessage(`<b>📈 Historical Level Alert</b>\n\nStock: <b>${symbol}</b>\nCurrent Price: ${currentPrice}\nPrice on ${refDate}: ${refHigh}\n\nStock has reached or exceeded its level from ${refDate}.`);
            sentAlertsCache.add(alertKey);
          }
        }
      } catch (err) {
        // Silent fail for individual stock errors
      }
    }
  } catch (err) {
    console.error('Alert worker error:', err);
  }
}

const BACKTEST_RANGE = env.BACKTEST_RANGE || '2y';
const BACKTEST_FAST_WINDOW = Math.max(2, Number(env.BACKTEST_FAST_WINDOW || 20));
const BACKTEST_SLOW_WINDOW = Math.max(BACKTEST_FAST_WINDOW + 1, Number(env.BACKTEST_SLOW_WINDOW || 50));
const BACKTEST_INITIAL_CASH = Math.max(1, Number(env.BACKTEST_INITIAL_CASH || 100000));
const BACKTEST_COMMISSION_BPS = Math.max(0, Number(env.BACKTEST_COMMISSION_BPS || 0));
const BACKTEST_BENCHMARK_SYMBOL = env.BACKTEST_BENCHMARK_SYMBOL || '^NSEI';
const BACKTEST_ENGINE = String(env.BACKTEST_ENGINE || 'js').trim().toLowerCase();
const PYTHON_BIN = env.PYTHON_BIN || 'python3';
const INSTRUMENTS_CACHE_PATH = resolve(projectRoot, 'server/.zerodha-instruments-cache.json');
const POSTBACK_LOG_PATH = resolve(projectRoot, 'server/.zerodha-postbacks.log');
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 Codex Portfolio Analyzer',
  Accept: 'application/json',
};
const FMP_HEADERS = {
  Accept: 'application/json',
};
function ensureSessionDir() {
  mkdirSync(dirname(SESSION_PATH), { recursive: true });
}

function readFileSession() {
  if (!existsSync(SESSION_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeFileSession(session) {
  ensureSessionDir();
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), 'utf8');
}

function clearFileSession() {
  if (existsSync(SESSION_PATH)) unlinkSync(SESSION_PATH);
}

async function readSession() {
  return readFileSession();
}

async function writeSession(session) {
  writeFileSession(session);
}

async function clearSession() {
  clearFileSession();
}

function readAuthContext() {
  return readJsonFile(AUTH_CONTEXT_PATH);
}

function writeAuthContext(context = {}) {
  writeJsonFile(AUTH_CONTEXT_PATH, context);
}

function clearAuthContext() {
  if (existsSync(AUTH_CONTEXT_PATH)) unlinkSync(AUTH_CONTEXT_PATH);
}

function getRequestFrontendOrigin(req) {
  const originHeader = String(req?.headers?.origin || '').trim();
  const refererHeader = String(req?.headers?.referer || req?.headers?.referrer || '').trim();
  const candidates = [originHeader, refererHeader];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      // Ignore invalid header values and fall back to the configured frontend URL.
    }
  }

  return FRONTEND_URL;
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolveBody(body));
    req.on('error', rejectBody);
  });
}

function logPostback(payload) {
  mkdirSync(dirname(POSTBACK_LOG_PATH), { recursive: true });
  appendFileSync(
    POSTBACK_LOG_PATH,
    `${new Date().toISOString()} ${JSON.stringify(payload)}\n`,
    'utf8',
  );
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Access-Control-Allow-Origin': '*',
  });
  res.end();
}

async function kiteRequest(path, { method = 'GET', body } = {}) {
  const session = await readSession();
  if (!session?.access_token) {
    throw new Error('No active Zerodha session.');
  }

  const response = await fetch(`https://api.kite.trade${path}`, {
    method,
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${API_KEY}:${session.access_token}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });

  const data = await response.json();
  if (!response.ok || data.status !== 'success') {
    throw new Error(data.message || 'Zerodha API request failed.');
  }
  return data;
}

async function kiteTextRequest(path) {
  const session = await readSession();
  if (!session?.access_token) {
    throw new Error('No active Zerodha session.');
  }

  const response = await fetch(`https://api.kite.trade${path}`, {
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${API_KEY}:${session.access_token}`,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error('Zerodha API request failed.');
  }
  return text;
}

async function exchangeRequestToken(requestToken) {
  const checksum = createHash('sha256')
    .update(`${API_KEY}${requestToken}${API_SECRET}`)
    .digest('hex');

  const body = new URLSearchParams({
    api_key: API_KEY,
    request_token: requestToken,
    checksum,
  });

  const response = await fetch('https://api.kite.trade/session/token', {
    method: 'POST',
    headers: {
      'X-Kite-Version': '3',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await response.json();
  if (!response.ok || data.status !== 'success') {
    throw new Error(data.message || 'Failed to exchange request token.');
  }

  await writeSession({
    connected_at: new Date().toISOString(),
    ...data.data,
  });
  return data.data;
}

function getLoginUrl() {
  const base = new URL('https://kite.zerodha.com/connect/login');
  base.searchParams.set('v', '3');
  base.searchParams.set('api_key', API_KEY);
  return base.toString();
}

function buildFrontendRedirect(status, error, target = 'web', frontendUrl = FRONTEND_URL) {
  if (target === 'native') {
    const url = new URL(NATIVE_REDIRECT_URL);
    url.searchParams.set('broker', 'zerodha');
    url.searchParams.set('status', status);
    if (error) url.searchParams.set('error', error);
    return url.toString();
  }

  const url = new URL('/Portfolio', frontendUrl || FRONTEND_URL);
  url.searchParams.set('broker', 'zerodha');
  url.searchParams.set('status', status);
  if (error) url.searchParams.set('error', error);
  return url.toString();
}

function normalizeQuoteSymbol(symbol = '') {
  const trimmed = symbol.trim().toUpperCase();
  if (!trimmed) return '';
  if (trimmed.includes('.')) return trimmed;
  return `${trimmed}.NS`;
}

const UNDERLYING_ALIAS_MAP = {
  NIFTY: ['NIFTY', 'NIFTY50', 'NIFTY 50', '^NSEI'],
  BANKNIFTY: ['BANKNIFTY', 'NIFTYBANK', 'BANK NIFTY', '^NSEBANK'],
  FINNIFTY: ['FINNIFTY', 'NIFTY FIN SERVICE', 'NIFTY FINANCIAL SERVICES'],
  MIDCPNIFTY: ['MIDCPNIFTY', 'MIDCAPNIFTY', 'NIFTY MID SELECT'],
};

const YAHOO_INDEX_ALIAS_MAP = {
  'NIFTY 50': '^NSEI',
  'NIFTY BANK': '^NSEBANK',
  'NIFTY NEXT 50': '^NSMIDCP',
  'NIFTY 500': 'NIFTY_500.NS',
  'NIFTY IT': '^CNXIT',
  'NIFTY AUTO': '^CNXAUTO',
  'NIFTY PHARMA': '^CNXPHARMA',
  'NIFTY FMCG': '^CNXFMCG',
  'NIFTY METAL': '^CNXMETAL',
  'NIFTY REALTY': '^CNXREALTY',
  'NIFTY ENERGY': '^CNXENERGY',
  'NIFTY INFRA': '^CNXINFRA',
  'NIFTY MEDIA': '^CNXMEDIA',
  'NIFTY PSU BANK': '^NIFTYPSU',
  'NIFTY PVT BANK': '^NIFTYPVTBANK',
  'NIFTY COMMODITIES': '^CNXCOMMODITIES',
};

function getUnderlyingAliases(symbol = '') {
  const trimmed = symbol.trim().toUpperCase();
  if (!trimmed) return [];
  return [...new Set([trimmed, ...(UNDERLYING_ALIAS_MAP[trimmed] || [])])];
}

function buildYahooSymbolCandidates(symbol = '', exchange = 'NSE') {
  const trimmed = symbol.trim().toUpperCase();
  const preferredExchange = exchange.trim().toUpperCase() || 'NSE';
  if (!trimmed) return [];
  if (UNDERLYING_ALIAS_MAP[trimmed]) {
    return [...new Set(getUnderlyingAliases(trimmed))];
  }
  if (YAHOO_INDEX_ALIAS_MAP[trimmed]) {
    return [...new Set([YAHOO_INDEX_ALIAS_MAP[trimmed], trimmed, `${YAHOO_INDEX_ALIAS_MAP[trimmed]}.NS`])];
  }
  if (trimmed.startsWith('^')) return [trimmed];
  if (trimmed.includes('_')) return [trimmed, `${trimmed}.NS`];
  if (trimmed.includes('.')) return [trimmed];

  const preferredSuffix = preferredExchange === 'BSE' ? '.BO' : '.NS';
  const alternateSuffix = preferredExchange === 'BSE' ? '.NS' : '.BO';

  return [...new Set([
    `${trimmed}${preferredSuffix}`,
    `${trimmed}${alternateSuffix}`,
    trimmed,
  ])];
}

function buildCompanySymbolCandidates(symbol = '') {
  const trimmed = symbol.trim().toUpperCase();
  if (!trimmed || trimmed.startsWith('^')) return [];
  if (trimmed.includes('.')) return [trimmed];
  return [...new Set([
    trimmed,
    `${trimmed}.NS`,
    `${trimmed}.BO`,
  ])];
}

function toNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function pickNumber(source, keys = [], fallback = null) {
  for (const key of keys) {
    const value = toNumber(source?.[key], null);
    if (value !== null) return value;
  }
  return fallback;
}

function computeGrowthPercent(currentValue, previousValue) {
  const current = toNumber(currentValue, null);
  const previous = toNumber(previousValue, null);
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function formatHeadlineNote(item) {
  if (!item) return null;
  const title = item.title || item.headline || item.text || '';
  const publishedAt = item.publishedDate || item.date || item.published_at || item.published;
  if (!title) return null;
  if (!publishedAt) return title;
  return `${title} (${String(publishedAt).slice(0, 10)})`;
}

function summarizeNewsRisk(items = []) {
  const recentItems = items.filter(Boolean);
  if (!recentItems.length) {
    return { value: null, note: null };
  }

  const riskTerms = ['downgrade', 'lawsuit', 'fraud', 'warning', 'miss', 'pledge', 'debt', 'probe', 'penalty', 'loss', 'decline'];
  const joinedText = recentItems
    .map((item) => `${item.title || ''} ${item.text || ''}`.toLowerCase())
    .join(' ');
  const hits = riskTerms.reduce((count, term) => count + (joinedText.includes(term) ? 1 : 0), 0);
  const value = hits >= 2 ? 'Elevated' : hits === 1 ? 'Mixed' : 'Calm';

  return {
    value,
    note: formatHeadlineNote(recentItems[0]),
  };
}

function summarizeCorporateActions(items = []) {
  const recentItems = items.filter(Boolean);
  if (!recentItems.length) {
    return { value: null, note: null };
  }

  return {
    value: `${recentItems.length} recent releases`,
    note: formatHeadlineNote(recentItems[0]),
  };
}

function isFirecrawlConfigured() {
  return Boolean(FIRECRAWL_API_KEY || /localhost|127\.0\.0\.1/i.test(FIRECRAWL_API_BASE_URL));
}

async function sendTelegramMessage(text = '', targetChatId = null) {
  const chatId = targetChatId || TELEGRAM_CHAT_ID;
  if (!TELEGRAM_BOT_TOKEN || !chatId || !text) {
    return null;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Telegram send failed:', error);
    return null;
  }
}

let telegramOffset = 0;

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN) return;

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=30`);
    const data = await response.json();

    if (data.ok && data.result && data.result.length > 0) {
      for (const update of data.result) {
        telegramOffset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    }
  } catch (error) {
    // Avoid spamming logs if network is down
  } finally {
    setTimeout(pollTelegramUpdates, 2000);
  }
}

async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim().toLowerCase();

  // Security: only respond to the configured chat ID if it exists
  if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    return;
  }

  if (text === '/start') {
    await sendTelegramMessage(`Welcome to StockOne Portfolio Bot!\n\nYour Chat ID is: <code>${chatId}</code>\n\nUse /summary to get your portfolio status.`, chatId);
  } else if (text === '/summary' || text === '/portfolio') {
    await handleTelegramSummary(chatId);
  } else if (text === '/positions') {
    await handleTelegramPositions(chatId);
  } else if (text.startsWith('/quote')) {
    const parts = message.text.split(' ');
    const symbol = parts[1]?.toUpperCase();
    if (!symbol) {
      await sendTelegramMessage('Please provide a symbol. Example: <code>/quote RELIANCE</code>', chatId);
    } else {
      await handleTelegramQuote(chatId, symbol);
    }
  } else if (text.startsWith('/news')) {
    const parts = message.text.split(' ');
    const symbol = parts[1]?.toUpperCase();
    if (!symbol) {
      await sendTelegramMessage('Please provide a symbol. Example: <code>/news RELIANCE</code>', chatId);
    } else {
      await handleTelegramNews(chatId, symbol);
    }
  } else if (text === '/help') {
    await sendTelegramMessage(`Available commands:\n/summary - Get portfolio P&L summary\n/portfolio - Same as /summary\n/positions - Get current open positions\n/quote SYMBOL - Get live price for a symbol\n/news SYMBOL - Get latest news for a symbol\n/help - Show this help`, chatId);
  }
}

async function handleTelegramQuote(chatId, symbol) {
  try {
    const quote = await fetchLiveQuote(symbol);
    
    if (!quote) {
      await sendTelegramMessage(`No quote found for <b>${symbol}</b>.`, chatId);
      return;
    }

    const changeEmoji = quote.changePercent >= 0 ? '🟢' : '🔴';
    const message = [
      `<b>📈 ${quote.shortName || symbol}</b>`,
      `Price: ₹${quote.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
      `Change: ${changeEmoji} ${quote.changePercent.toFixed(2)}%`,
      `Exchange: ${quote.exchange || 'NSE'}`,
      '',
      `<a href="${FRONTEND_URL}">Open Dashboard</a>`,
    ].join('\n');

    await sendTelegramMessage(message, chatId);
  } catch (error) {
    await sendTelegramMessage(`Error: ${error.message}`, chatId);
  }
}

async function handleTelegramNews(chatId, symbol) {
  try {
    const newsItems = await fetchFmp('news/stock', { symbols: symbol, limit: 5 });
    
    if (!newsItems || !newsItems.length) {
      await sendTelegramMessage(`No recent news found for <b>${symbol}</b>.`, chatId);
      return;
    }

    const lines = [`<b>📰 Latest News: ${symbol}</b>`, ''];
    newsItems.forEach((item) => {
      const date = item.publishedDate ? new Date(item.publishedDate).toLocaleDateString('en-IN') : '';
      lines.push(`<b>${item.title}</b>`);
      if (date) lines.push(`<i>${date}</i>`);
      lines.push(`<a href="${item.url}">Read more</a>`);
      lines.push('');
    });

    await sendTelegramMessage(lines.join('\n'), chatId);
  } catch (error) {
    await sendTelegramMessage(`Error: ${error.message}`, chatId);
  }
}

async function handleTelegramPositions(chatId) {
  try {
    const data = await kiteRequest('/portfolio/positions');
    const netPositions = data?.data?.net || [];
    
    if (!netPositions.length) {
      await sendTelegramMessage('No open positions found.', chatId);
      return;
    }

    let totalPL = 0;
    const lines = ['<b>📂 Open Positions</b>', ''];

    netPositions.forEach((p) => {
      if (p.quantity !== 0) {
        const pl = (p.last_price - p.average_price) * p.quantity * (p.multiplier || 1) + p.realised;
        totalPL += pl;
        lines.push(`<b>${p.tradingsymbol}</b> (${p.exchange})`);
        lines.push(`Qty: ${p.quantity} | Avg: ${p.average_price.toFixed(2)}`);
        lines.push(`LTP: ${p.last_price.toFixed(2)} | P&L: ${pl >= 0 ? '🟢' : '🔴'} ₹${pl.toFixed(2)}`);
        lines.push('');
      }
    });

    if (lines.length <= 2) {
      await sendTelegramMessage('No active open positions found.', chatId);
      return;
    }

    lines.push(`<b>Total Net P&L: ${totalPL >= 0 ? '🟢' : '🔴'} ₹${totalPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</b>`);
    await sendTelegramMessage(lines.join('\n'), chatId);
  } catch (error) {
    await sendTelegramMessage(`Error: ${error.message}`, chatId);
  }
}

async function handleTelegramSummary(chatId) {
  try {
    const data = await kiteRequest('/portfolio/holdings');
    const holdings = data?.data || [];
    
    if (!holdings.length) {
      await sendTelegramMessage('No holdings found to summarize.', chatId);
      return;
    }

    let totalInvested = 0;
    let totalCurrentValue = 0;
    holdings.forEach((h) => {
      totalInvested += h.quantity * h.average_price;
      totalCurrentValue += h.quantity * h.last_price;
    });

    const totalPL = totalCurrentValue - totalInvested;
    const plPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

    const message = [
      '<b>📊 Portfolio Summary</b>',
      '',
      `Total Invested: ₹${totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
      `Current Value: ₹${totalCurrentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
      '',
      `<b>Overall P&L: ${totalPL >= 0 ? '🟢' : '🔴'} ₹${totalPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</b>`,
      `Percentage: ${plPercent.toFixed(2)}%`,
      '',
      `<a href="${FRONTEND_URL}">Open Dashboard</a>`,
    ].join('\n');

    await sendTelegramMessage(message, chatId);
  } catch (error) {
    await sendTelegramMessage(`Error: ${error.message}`, chatId);
  }
}

async function fetchFmp(path, params = {}) {
  if (!FMP_API_KEY) {
    throw new Error('FMP feed not configured.');
  }

  const baseUrl = `${FMP_API_BASE_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  url.searchParams.set('apikey', FMP_API_KEY);

  const response = await fetch(url, { headers: FMP_HEADERS });
  const data = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(data?.error || data?.message || 'FMP request failed.');
  }
  return data;
}

async function fetchFirecrawlSearch(query = '', limit = 3) {
  if (!isFirecrawlConfigured()) {
    throw new Error('Firecrawl feed not configured.');
  }

  const baseUrl = trimTrailingSlash(FIRECRAWL_API_BASE_URL || 'https://api.firecrawl.dev');
  const response = await fetch(`${baseUrl}/v2/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(FIRECRAWL_API_KEY ? { Authorization: `Bearer ${FIRECRAWL_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      query,
      limit: Math.max(1, Math.min(Number(limit) || 3, 5)),
      sources: ['web'],
      timeout: 15000,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
        maxAge: 24 * 60 * 60 * 1000,
      },
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || data?.message || 'Firecrawl request failed.');
  }

  return Array.isArray(data?.data?.web) ? data.data.web : [];
}

function buildFirecrawlQuery(symbol = '', name = '', exchange = '') {
  const parts = [symbol, name, exchange, 'stock news', 'earnings', 'latest'];
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

function summarizeFirecrawlItems(items = []) {
  const entries = items
    .filter(Boolean)
    .map((item) => ({
      title: String(item.title || '').trim(),
      description: String(item.description || '').trim(),
      url: String(item.url || '').trim(),
    }))
    .filter((item) => item.title || item.description || item.url);

  if (!entries.length) {
    return {
      headline: null,
      summary: null,
      items: [],
    };
  }

  return {
    headline: entries[0].title || entries[0].description || entries[0].url,
    summary: entries
      .slice(0, 3)
      .map((item) => item.title || item.description)
      .filter(Boolean)
      .join(' | '),
    items: entries.slice(0, 3),
  };
}

async function fetchFirecrawlContext(symbol = '', name = '', exchange = '') {
  if (!isFirecrawlConfigured()) {
    return null;
  }

  const query = buildFirecrawlQuery(symbol, name, exchange);
  if (!query) return null;

  const results = await fetchFirecrawlSearch(query, 3);
  const context = summarizeFirecrawlItems(results);
  if (!context.items.length) return null;

  return {
    query,
    ...context,
  };
}

async function resolveCompanyFeedSymbol(symbol = '') {
  const candidates = buildCompanySymbolCandidates(symbol);
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    try {
      const payload = await fetchFmp('profile', { symbol: candidate });
      const profile = extractArrayPayload(payload)[0];
      if (profile) {
        return { symbol: candidate, profile };
      }
    } catch {
      // keep scanning other candidates
    }
  }

  try {
    const payload = await fetchFmp('search-exchange-variants', { symbol: symbol.trim().toUpperCase() });
    const variants = extractArrayPayload(payload);
    const preferred = variants.find((item) => ['NSE', 'BSE'].includes(String(item.exchangeShortName || item.exchange || '').toUpperCase()));
    if (preferred?.symbol) {
      return { symbol: preferred.symbol, profile: null };
    }
  } catch {
    // keep fallback null
  }

  return null;
}

async function fetchCompanyIntelligence(symbol = '') {
  if (!FMP_API_KEY) {
    return {
      configured: false,
      source: 'unconfigured',
      symbol: symbol.trim().toUpperCase(),
      valuation: {},
      quality: {},
      stockSpecificRisk: {},
      notes: {},
      meta: {
        provider: 'fmp',
        reason: 'FMP_API_KEY missing',
      },
    };
  }

  const resolved = await resolveCompanyFeedSymbol(symbol);
  if (!resolved?.symbol) {
    return {
      configured: true,
      source: 'fmp',
      symbol: symbol.trim().toUpperCase(),
      valuation: {},
      quality: {},
      stockSpecificRisk: {},
      notes: {},
      meta: {
        provider: 'fmp',
        reason: 'Symbol not found in provider feed',
      },
    };
  }

  const profile = resolved.profile || null;
  const settled = await Promise.allSettled([
    fetchFmp('profile', { symbol: resolved.symbol }),
    fetchFmp('key-metrics-ttm', { symbol: resolved.symbol }),
    fetchFmp('ratios-ttm', { symbol: resolved.symbol }),
    fetchFmp('income-statement', { symbol: resolved.symbol, period: 'annual', limit: 2 }),
    fetchFmp('income-statement', { symbol: resolved.symbol, period: 'quarter', limit: 2 }),
    fetchFmp('cash-flow-statement', { symbol: resolved.symbol, period: 'annual', limit: 1 }),
    fetchFmp('company-executives', { symbol: resolved.symbol }),
    fetchFmp('news/stock', { symbols: resolved.symbol, limit: 5 }),
    fetchFmp('news/press-releases', { symbols: resolved.symbol, limit: 3 }),
  ]);

  const [
    profileResult,
    keyMetricsResult,
    ratiosResult,
    annualIncomeResult,
    quarterlyIncomeResult,
    cashFlowResult,
    executivesResult,
    newsResult,
    pressReleaseResult,
  ] = settled;

  const liveProfile = extractArrayPayload(profileResult.status === 'fulfilled' ? profileResult.value : [profile])[0] || profile;
  const keyMetrics = extractArrayPayload(keyMetricsResult.status === 'fulfilled' ? keyMetricsResult.value : [])[0] || {};
  const ratios = extractArrayPayload(ratiosResult.status === 'fulfilled' ? ratiosResult.value : [])[0] || {};
  const annualIncomeRows = extractArrayPayload(annualIncomeResult.status === 'fulfilled' ? annualIncomeResult.value : []);
  const quarterlyIncomeRows = extractArrayPayload(quarterlyIncomeResult.status === 'fulfilled' ? quarterlyIncomeResult.value : []);
  const cashFlowRows = extractArrayPayload(cashFlowResult.status === 'fulfilled' ? cashFlowResult.value : []);
  const executives = extractArrayPayload(executivesResult.status === 'fulfilled' ? executivesResult.value : []);
  const newsItems = extractArrayPayload(newsResult.status === 'fulfilled' ? newsResult.value : []);
  const pressReleases = extractArrayPayload(pressReleaseResult.status === 'fulfilled' ? pressReleaseResult.value : []);

  const annualCurrent = annualIncomeRows[0] || {};
  const annualPrevious = annualIncomeRows[1] || {};
  const quarterlyCurrent = quarterlyIncomeRows[0] || {};
  const quarterlyPrevious = quarterlyIncomeRows[1] || {};
  const latestCashFlow = cashFlowRows[0] || {};
  const newsRisk = summarizeNewsRisk(newsItems);
  const corporateActions = summarizeCorporateActions(pressReleases);

  return {
    configured: true,
    source: 'fmp',
    symbol: resolved.symbol,
    valuation: {
      peRatio: pickNumber(keyMetrics, ['peRatioTTM', 'peRatio'], pickNumber(ratios, ['priceEarningsRatioTTM'], pickNumber(liveProfile, ['pe'], null))),
      pegRatio: pickNumber(ratios, ['pegRatioTTM', 'pegRatio'], null),
      pbRatio: pickNumber(keyMetrics, ['pbRatioTTM', 'priceToBookRatioTTM', 'pbRatio'], pickNumber(ratios, ['priceToBookRatioTTM', 'priceToBookRatio'], null)),
      evToEbitda: pickNumber(keyMetrics, ['enterpriseValueOverEBITDATTM', 'evToEbitdaTTM'], pickNumber(ratios, ['enterpriseValueMultipleTTM', 'enterpriseValueMultiple'], null)),
      marketCap: pickNumber(liveProfile, ['mktCap', 'marketCap'], null),
    },
    quality: {
      earningsGrowthYoYPercent: computeGrowthPercent(annualCurrent.netIncome, annualPrevious.netIncome),
      earningsGrowthQoQPercent: computeGrowthPercent(quarterlyCurrent.netIncome, quarterlyPrevious.netIncome),
      revenueGrowthPercent: computeGrowthPercent(annualCurrent.revenue, annualPrevious.revenue),
      roePercent: pickNumber(keyMetrics, ['roeTTM', 'roe'], pickNumber(ratios, ['returnOnEquityTTM', 'returnOnEquity'], null)),
      rocePercent: pickNumber(keyMetrics, ['roicTTM', 'returnOnCapitalEmployedTTM'], pickNumber(ratios, ['returnOnCapitalEmployedTTM', 'returnOnCapitalEmployed'], null)),
      debtToEquity: pickNumber(ratios, ['debtEquityRatioTTM', 'debtToEquityTTM', 'debtEquityRatio', 'debtToEquity'], null),
      freeCashFlow: pickNumber(latestCashFlow, ['freeCashFlow', 'freeCashFlowTTM'], null),
    },
    stockSpecificRisk: {
      managementQuality: null,
      promoterHoldingPercent: null,
      promoterPledgePercent: null,
      latestNewsRisk: newsRisk.value,
      corporateActions: corporateActions.value,
    },
    notes: {
      quality: {
        earningsGrowthYoYPercent: annualCurrent.date ? `Annual net income growth from ${annualCurrent.date}` : null,
        earningsGrowthQoQPercent: quarterlyCurrent.date ? `Quarterly net income growth from ${quarterlyCurrent.date}` : null,
        revenueGrowthPercent: annualCurrent.date ? `Annual revenue growth from ${annualCurrent.date}` : null,
        roePercent: 'Trailing twelve-month return on equity',
        rocePercent: 'Provider return-on-capital proxy',
        debtToEquity: 'Trailing leverage ratio',
        freeCashFlow: latestCashFlow.date ? `Latest annual cash-flow statement ${latestCashFlow.date}` : null,
      },
      valuation: {
        peRatio: liveProfile?.companyName ? `${liveProfile.companyName} profile + TTM metrics` : 'Provider valuation feed',
        pegRatio: 'Growth-adjusted valuation from provider feed',
        pbRatio: 'Price-to-book from provider feed',
        evToEbitda: 'Enterprise value versus EBITDA from provider feed',
      },
      stockSpecificRisk: {
        managementQuality: executives.length ? `${executives.length} executives available; qualitative scoring still manual.` : 'Executive feed not available for this symbol.',
        promoterHoldingPercent: 'Promoter holding feed still not connected for Indian disclosures.',
        promoterPledgePercent: 'Promoter pledge feed still not connected for Indian disclosures.',
        latestNewsRisk: newsRisk.note,
        corporateActions: corporateActions.note,
      },
    },
    meta: {
      provider: 'fmp',
      executivesCount: executives.length,
      newsCount: newsItems.length,
      pressReleaseCount: pressReleases.length,
      companyName: liveProfile?.companyName || liveProfile?.name || null,
      sector: liveProfile?.sector || null,
    },
  };
}

function parseCsv(text = '') {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index];
    });
    return row;
  });
}

function parseExpiryDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getZerodhaInstruments() {
  const cached = readJsonFile(INSTRUMENTS_CACHE_PATH);
  const now = Date.now();

  if (cached?.fetchedAt && Array.isArray(cached.rows) && (now - cached.fetchedAt) < (12 * 60 * 60 * 1000)) {
    return cached.rows;
  }

  try {
    const text = await kiteTextRequest('/instruments');
    const rows = parseCsv(text);
    writeJsonFile(INSTRUMENTS_CACHE_PATH, { fetchedAt: now, rows });
    return rows;
  } catch (error) {
    if (Array.isArray(cached?.rows) && cached.rows.length > 0) {
      return cached.rows;
    }
    throw error;
  }
}

async function searchMarketSymbols(query = '', limit = 12) {
  const term = query.trim().toUpperCase();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
  const results = [];
  const seen = new Set();

  INDEX_CATALOG.forEach((item) => {
    const label = item.label || '';
    if (term && !label.includes(term) && !item.symbol.includes(term)) {
      return;
    }

    const key = `INDEX:${item.symbol}`;
    if (seen.has(key) || results.length >= safeLimit) {
      return;
    }

    seen.add(key);
    results.push({
      symbol: item.symbol,
      name: item.label,
      exchange: 'INDEX',
      type: 'index',
    });
  });

  const instruments = await getZerodhaInstruments();
  for (const row of instruments) {
    const exchange = (row.exchange || '').toUpperCase();
    const instrumentType = (row.instrument_type || '').toUpperCase();
    const symbol = (row.tradingsymbol || '').toUpperCase();
    const name = (row.name || '').trim();

    if (!['NSE', 'BSE'].includes(exchange)) continue;
    if (instrumentType && instrumentType !== 'EQ') continue;
    if (!symbol) continue;

    const haystack = `${symbol} ${name}`.toUpperCase();
    if (term && !haystack.includes(term)) continue;

    const key = `${exchange}:${symbol}`;
    if (seen.has(key)) continue;

    seen.add(key);
    results.push({
      symbol,
      name: name || symbol,
      exchange,
      type: 'stock',
    });

    if (results.length >= safeLimit) break;
  }

  return results;
}

async function resolveZerodhaInstrument(symbol = '', exchange = 'NSE') {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedExchange = exchange.trim().toUpperCase() || 'NSE';
  if (!normalizedSymbol) return null;

  const instruments = await getZerodhaInstruments();
  const aliases = getUnderlyingAliases(normalizedSymbol);
  const exact = instruments.find((row) => aliases.includes((row.tradingsymbol || '').toUpperCase()) && row.exchange === normalizedExchange);
  if (exact) return exact;

  const alternate = instruments.find((row) => aliases.includes((row.tradingsymbol || '').toUpperCase()));
  return alternate || null;
}

function matchesDerivativeUnderlying(row, symbol = '') {
  const aliases = getUnderlyingAliases(symbol);
  const name = (row.name || '').toUpperCase();
  const tradingsymbol = (row.tradingsymbol || '').toUpperCase();
  return aliases.some((alias) => alias === name || tradingsymbol.startsWith(alias));
}

async function fetchZerodhaQuoteSnapshot(instrumentRefs = []) {
  if (!instrumentRefs.length) return {};
  const search = instrumentRefs.map((item) => `i=${encodeURIComponent(item)}`).join('&');
  const response = await kiteRequest(`/quote?${search}`);
  return response?.data || {};
}

async function fetchZerodhaQuote(symbol, exchange = 'NSE') {
  const instrumentRef = `${exchange.toUpperCase()}:${symbol.toUpperCase()}`;
  const response = await kiteRequest(`/quote/ltp?i=${encodeURIComponent(instrumentRef)}`);
  const quote = response?.data?.[instrumentRef];
  if (!quote?.last_price) {
    throw new Error(`No Zerodha quote available for ${instrumentRef}.`);
  }

  return {
    symbol: symbol.toUpperCase(),
    marketSymbol: instrumentRef,
    shortName: symbol.toUpperCase(),
    price: Number(quote.last_price || 0),
    changePercent: 0,
    exchange: exchange.toUpperCase(),
    currency: 'INR',
    source: 'zerodha',
  };
}

function buildZerodhaDateRange(range = '6mo', interval = 'day') {
  const to = new Date();
  const from = new Date(to);
  let resolvedInterval = interval || 'day';

  if (range === '1d') {
    from.setDate(to.getDate() - 1);
  } else if (range === '5d') {
    from.setDate(to.getDate() - 5);
  } else if (range === '1mo') {
    from.setMonth(to.getMonth() - 1);
  } else if (range === '3mo') {
    from.setMonth(to.getMonth() - 3);
  } else if (range === '6mo') {
    from.setMonth(to.getMonth() - 6);
  } else if (range === '1y') {
    from.setFullYear(to.getFullYear() - 1);
  } else if (range === '3y') {
    from.setFullYear(to.getFullYear() - 3);
  } else if (range === '5y') {
    from.setFullYear(to.getFullYear() - 5);
  } else if (range === 'ytd') {
    from.setMonth(0, 1);
    from.setHours(0, 0, 0, 0);
  } else if (range === 'all') {
    from.setFullYear(to.getFullYear() - 15);
  }

  return {
    from,
    to,
    interval: resolvedInterval,
  };
}

function getZerodhaChunkDays(interval = 'day') {
  const limits = {
    minute: 60,
    '3minute': 100,
    '5minute': 100,
    '10minute': 100,
    '15minute': 200,
    '30minute': 200,
    '60minute': 400,
    day: 2000,
  };

  return limits[interval] || 60;
}

function mapRequestedInterval(requestedInterval = 'day', range = '1d') {
  const normalized = requestedInterval.toLowerCase();
  const allowed = new Set(['minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute', 'day']);
  if (allowed.has(normalized)) return normalized;

  if (normalized === '1m') return 'minute';
  if (normalized === '3m') return '3minute';
  if (normalized === '5m') return '5minute';
  if (normalized === '10m') return '10minute';
  if (normalized === '15m') return '15minute';
  if (normalized === '30m') return '30minute';
  if (normalized === '60m' || normalized === '1h') return '60minute';
  if (normalized === '180m' || normalized === '3h') return '60minute';
  if (normalized === '1d') return 'day';
  if (normalized === '1w' || normalized === '1mo') return 'day';

  if (range === '1d') return '5minute';
  if (range === '5d') return '15minute';
  return 'day';
}

function mapYahooInterval(requestedInterval = '1d', range = '1d') {
  const normalized = requestedInterval.toLowerCase();
  const direct = new Map([
    ['minute', '1m'],
    ['1m', '1m'],
    ['2m', '2m'],
    ['3minute', '5m'],
    ['3m', '5m'],
    ['5minute', '5m'],
    ['5m', '5m'],
    ['10minute', '15m'],
    ['10m', '15m'],
    ['15minute', '15m'],
    ['15m', '15m'],
    ['30minute', '30m'],
    ['30m', '30m'],
    ['60minute', '60m'],
    ['60m', '60m'],
    ['1h', '1h'],
    ['180m', '1h'],
    ['3h', '1h'],
    ['day', '1d'],
    ['1d', '1d'],
    ['1w', '1wk'],
    ['1mo', '1mo'],
    ['5d', '5d'],
  ]);

  if (direct.has(normalized)) {
    return direct.get(normalized);
  }

  if (range === '1d') return '5m';
  if (range === '5d') return '15m';
  if (range === 'all') return '1mo';
  return '1d';
}

async function fetchZerodhaHistory(symbol, exchange = 'NSE', range = '6mo', requestedInterval = 'day') {
  const instrument = await resolveZerodhaInstrument(symbol, exchange);
  if (!instrument?.instrument_token) {
    throw new Error(`No Zerodha instrument token found for ${exchange}:${symbol}.`);
  }

  const interval = mapRequestedInterval(requestedInterval, range);
  const { from, to } = buildZerodhaDateRange(range, interval);
  const chunkDays = getZerodhaChunkDays(interval);
  const candles = [];
  let cursor = new Date(from);

  while (cursor <= to) {
    const chunkEnd = new Date(
      Math.min(
        to.getTime(),
        cursor.getTime() + (chunkDays * 24 * 60 * 60 * 1000) - 1000,
      ),
    );

    const response = await kiteRequest(
      `/instruments/historical/${instrument.instrument_token}/${interval}?from=${encodeURIComponent(cursor.toISOString())}&to=${encodeURIComponent(chunkEnd.toISOString())}&oi=0`,
    );

    candles.push(...(response?.data?.candles || []));
    cursor = new Date(chunkEnd.getTime() + 1000);
  }

  const uniqueCandles = [...new Map(
    candles.map((entry) => [new Date(entry[0]).toISOString(), entry]),
  ).values()];
  const points = uniqueCandles
    .map((entry) => ({
      date: new Date(entry[0]).toISOString(),
      open: Number(entry[1]),
      high: Number(entry[2]),
      low: Number(entry[3]),
      close: Number(entry[4]),
      volume: Number(entry[5] || 0),
    }))
    .filter((point) => [point.open, point.high, point.low, point.close].every(Number.isFinite));

  if (points.length === 0) {
    throw new Error(`No Zerodha candle data available for ${exchange}:${symbol}.`);
  }

  return {
    symbol: instrument.tradingsymbol || symbol.toUpperCase(),
    marketSymbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
    currency: 'INR',
    exchange: instrument.exchange || exchange,
    source: 'zerodha',
    points,
  };
}

function computeOptionSummary(rows = []) {
  if (!rows.length) return null;

  const totalCallOi = rows.reduce((sum, row) => sum + Number(row.call?.oi || 0), 0);
  const totalPutOi = rows.reduce((sum, row) => sum + Number(row.put?.oi || 0), 0);
  const pcr = totalCallOi > 0 ? totalPutOi / totalCallOi : 0;

  const supportStrike = [...rows]
    .sort((left, right) => Number(right.put?.oi || 0) - Number(left.put?.oi || 0))[0]?.strike || null;
  const resistanceStrike = [...rows]
    .sort((left, right) => Number(right.call?.oi || 0) - Number(left.call?.oi || 0))[0]?.strike || null;

  const maxPain = rows.reduce((best, candidate) => {
    const pain = rows.reduce((sum, row) => {
      const callPain = Math.max(candidate.strike - row.strike, 0) * Number(row.call?.oi || 0);
      const putPain = Math.max(row.strike - candidate.strike, 0) * Number(row.put?.oi || 0);
      return sum + callPain + putPain;
    }, 0);

    if (!best || pain < best.pain) {
      return { strike: candidate.strike, pain };
    }
    return best;
  }, null);

  return {
    totalCallOi,
    totalPutOi,
    pcr,
    supportStrike,
    resistanceStrike,
    maxPainStrike: maxPain?.strike || null,
  };
}

function computeExpirySummaries(optionRows = [], spotPrice = 0) {
  const grouped = new Map();

  optionRows.forEach((row) => {
    const expiry = row.expiry;
    if (!expiry) return;
    const bucket = grouped.get(expiry) || {
      expiry,
      totalCallOi: 0,
      totalPutOi: 0,
      nearestStrikeDistance: Number.POSITIVE_INFINITY,
      atmStrike: null,
    };

    const strike = Number(row.strike || 0);
    const distance = Math.abs(strike - spotPrice);
    if (distance < bucket.nearestStrikeDistance) {
      bucket.nearestStrikeDistance = distance;
      bucket.atmStrike = strike;
    }

    if ((row.instrument_type || '').toUpperCase() === 'CE') {
      bucket.totalCallOi += 1;
    }
    if ((row.instrument_type || '').toUpperCase() === 'PE') {
      bucket.totalPutOi += 1;
    }

    grouped.set(expiry, bucket);
  });

  return [...grouped.values()]
    .map((item) => ({
      expiry: item.expiry,
      atmStrike: item.atmStrike,
      totalCallOi: item.totalCallOi,
      totalPutOi: item.totalPutOi,
      pcr: item.totalCallOi > 0 ? item.totalPutOi / item.totalCallOi : 0,
    }))
    .sort((left, right) => parseExpiryDate(left.expiry) - parseExpiryDate(right.expiry));
}

async function fetchZerodhaFuturesBoard(symbol, exchange = 'NSE') {
  const uppercaseSymbol = symbol.trim().toUpperCase();
  if (!uppercaseSymbol) {
    throw new Error('Missing symbol for futures board.');
  }

  const instruments = await getZerodhaInstruments();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const futuresRows = instruments
    .filter((row) => {
      const instrumentType = (row.instrument_type || '').toUpperCase();
      const rowExchange = (row.exchange || '').toUpperCase();
      return rowExchange === 'NFO' && instrumentType === 'FUT' && matchesDerivativeUnderlying(row, uppercaseSymbol);
    })
    .map((row) => ({
      ...row,
      expiryDate: parseExpiryDate(row.expiry),
      lot_size: Number(row.lot_size || 0),
    }))
    .filter((row) => row.expiryDate && row.expiryDate >= today)
    .sort((left, right) => left.expiryDate - right.expiryDate)
    .slice(0, 3);

  if (!futuresRows.length) {
    throw new Error(`No active Zerodha futures instruments found for ${uppercaseSymbol}.`);
  }

  const quoteRefs = futuresRows.map((row) => `${row.exchange}:${row.tradingsymbol}`);
  const quotes = await fetchZerodhaQuoteSnapshot(quoteRefs);
  const underlyingQuote = await fetchLiveQuote(uppercaseSymbol);

  return {
    source: 'zerodha',
    symbol: uppercaseSymbol,
    exchange,
    spotPrice: underlyingQuote.price,
    lotSize: Number(futuresRows[0]?.lot_size || 0),
    rows: futuresRows.map((row) => {
      const quote = quotes[`${row.exchange}:${row.tradingsymbol}`] || {};
      const lastPrice = Number(quote.last_price || 0);
      const basis = lastPrice - underlyingQuote.price;
      const basisPercent = underlyingQuote.price ? (basis / underlyingQuote.price) * 100 : 0;
      return {
        tradingsymbol: row.tradingsymbol,
        expiry: row.expiry,
        instrumentToken: row.instrument_token,
        lotSize: Number(row.lot_size || 0),
        lastPrice,
        change: Number(quote.net_change || 0),
        oi: Number(quote.oi || 0),
        volume: Number(quote.volume || 0),
        basis,
        basisPercent,
      };
    }),
  };
}

async function fetchZerodhaOptionChain(symbol, exchange = 'NSE', expiry = '', strikeCount = 9) {
  const uppercaseSymbol = symbol.trim().toUpperCase();
  if (!uppercaseSymbol) {
    throw new Error('Missing symbol for option chain.');
  }

  const instruments = await getZerodhaInstruments();
  const optionRows = instruments.filter((row) => {
    const instrumentType = (row.instrument_type || '').toUpperCase();
    const rowExchange = (row.exchange || '').toUpperCase();
    return rowExchange === 'NFO' && matchesDerivativeUnderlying(row, uppercaseSymbol) && (instrumentType === 'CE' || instrumentType === 'PE');
  });

  if (!optionRows.length) {
    throw new Error(`No Zerodha option instruments found for ${uppercaseSymbol}.`);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiries = [...new Set(
    optionRows
      .map((row) => row.expiry)
      .filter(Boolean),
  )]
    .map((value) => ({ raw: value, date: parseExpiryDate(value) }))
    .filter((entry) => entry.date && entry.date >= today)
    .sort((left, right) => left.date - right.date);

  const selectedExpiry = expiry && expiries.some((item) => item.raw === expiry) ? expiry : expiries[0]?.raw;
  if (!selectedExpiry) {
    throw new Error(`No active expiry found for ${uppercaseSymbol}.`);
  }

  const underlyingQuote = await fetchLiveQuote(uppercaseSymbol);
  const spotPrice = underlyingQuote.price;

  const expiryOptions = optionRows
    .filter((row) => row.expiry === selectedExpiry)
    .map((row) => ({
      ...row,
      strike: Number(row.strike || 0),
      lot_size: Number(row.lot_size || 0),
      instrument_type: (row.instrument_type || '').toUpperCase(),
    }))
    .filter((row) => Number.isFinite(row.strike) && row.strike > 0)
    .sort((left, right) => left.strike - right.strike);

  const uniqueStrikes = [...new Set(expiryOptions.map((row) => row.strike))];
  const atmStrike = uniqueStrikes.reduce((closest, strike) => {
    if (closest === null) return strike;
    return Math.abs(strike - spotPrice) < Math.abs(closest - spotPrice) ? strike : closest;
  }, null);

  const atmIndex = uniqueStrikes.findIndex((strike) => strike === atmStrike);
  const safeStrikeCount = Math.max(5, Math.min(Number(strikeCount) || 9, 21));
  const sideWindow = Math.floor(safeStrikeCount / 2);
  const selectedStrikes = uniqueStrikes.slice(
    Math.max(0, atmIndex - sideWindow),
    Math.min(uniqueStrikes.length, atmIndex + sideWindow + 1),
  );

  const selectedOptions = expiryOptions.filter((row) => selectedStrikes.includes(row.strike));
  const quoteRefs = selectedOptions.map((row) => `${row.exchange}:${row.tradingsymbol}`);
  const quotes = await fetchZerodhaQuoteSnapshot(quoteRefs);

  const grouped = selectedStrikes.map((strike) => {
    const call = selectedOptions.find((row) => row.strike === strike && row.instrument_type === 'CE');
    const put = selectedOptions.find((row) => row.strike === strike && row.instrument_type === 'PE');
    const callQuote = call ? quotes[`${call.exchange}:${call.tradingsymbol}`] : null;
    const putQuote = put ? quotes[`${put.exchange}:${put.tradingsymbol}`] : null;

    return {
      strike,
      atm: strike === atmStrike,
      call: call ? {
        tradingsymbol: call.tradingsymbol,
        ltp: Number(callQuote?.last_price || 0),
        oi: Number(callQuote?.oi || 0),
        oiDayHigh: Number(callQuote?.oi_day_high || 0),
        oiDayLow: Number(callQuote?.oi_day_low || 0),
        volume: Number(callQuote?.volume || 0),
      } : null,
      put: put ? {
        tradingsymbol: put.tradingsymbol,
        ltp: Number(putQuote?.last_price || 0),
        oi: Number(putQuote?.oi || 0),
        oiDayHigh: Number(putQuote?.oi_day_high || 0),
        oiDayLow: Number(putQuote?.oi_day_low || 0),
        volume: Number(putQuote?.volume || 0),
      } : null,
    };
  });

  const summary = computeOptionSummary(grouped);

  return {
    source: 'zerodha',
    symbol: uppercaseSymbol,
    exchange,
    expiry: selectedExpiry,
    expiries: expiries.map((entry) => entry.raw),
    expirySummaries: computeExpirySummaries(optionRows, spotPrice),
    spotPrice,
    atmStrike,
    lotSize: Number(selectedOptions[0]?.lot_size || 0),
    strikeCount: selectedStrikes.length,
    summary,
    rows: grouped,
  };
}

async function fetchLiveQuote(symbol, exchange = 'NSE') {
  try {
    const zerodhaQuote = await fetchZerodhaQuote(symbol, exchange);
    return zerodhaQuote;
  } catch {
    // fall through to Yahoo fallback when Zerodha is disconnected or unavailable
  }

  const candidates = buildYahooSymbolCandidates(symbol, exchange);
  if (candidates.length === 0) {
    throw new Error('Missing stock symbol.');
  }

  for (const candidate of candidates) {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${candidate}`);
    url.searchParams.set('range', '5d');
    url.searchParams.set('interval', '1d');

    const response = await fetch(url, { headers: YAHOO_HEADERS });
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const quote = result?.meta;

    if (!response.ok || !quote?.regularMarketPrice) {
      continue;
    }

    return {
      symbol: quote.symbol || candidate,
      marketSymbol: candidate,
      shortName: quote.shortName || quote.longName || candidate,
      price: Number(quote.regularMarketPrice || 0),
      changePercent: Number(quote.regularMarketChangePercent || 0),
      exchange: quote.exchangeName || quote.fullExchangeName || '',
      currency: quote.currency || 'INR',
      source: 'yahoo',
    };
  }

  throw new Error(`No live quote available for ${candidates.join(', ')}.`);
}

const INDEX_CATALOG = [
  { key: 'nifty50', symbol: '^NSEI', label: 'NIFTY 50', fallbackPrice: 22419.95, fallbackChangePercent: -0.24 },
  { key: 'banknifty', symbol: '^NSEBANK', label: 'BANK NIFTY', fallbackPrice: 48265.2, fallbackChangePercent: -0.31 },
  { key: 'sensex', symbol: '^BSESN', label: 'SENSEX', fallbackPrice: 73642.15, fallbackChangePercent: -0.18 },
  { key: 'niftynext50', symbol: '^NSMIDCP', label: 'NIFTY NEXT 50', fallbackPrice: 62184.3, fallbackChangePercent: 0.12 },
  { key: 'midcap100', symbol: 'NIFTY_MIDCAP_100.NS', label: 'MIDCAP 100', fallbackPrice: 51432.8, fallbackChangePercent: 0.21 },
  { key: 'midcap150', symbol: 'NIFTY_MIDCAP_150.NS', label: 'MIDCAP 150', fallbackPrice: 19864.3, fallbackChangePercent: 0.17 },
  { key: 'smallcap100', symbol: 'NIFTY_SMLCAP_100.NS', label: 'SMALLCAP 100', fallbackPrice: 16782.45, fallbackChangePercent: -0.09 },
  { key: 'smallcap250', symbol: 'NIFTY_SMALLCAP_250.NS', label: 'SMALLCAP 250', fallbackPrice: 14586.25, fallbackChangePercent: 0.28 },
  { key: 'nifty500', symbol: 'NIFTY_500.NS', label: 'NIFTY 500', fallbackPrice: 20894.6, fallbackChangePercent: 0.05 },
  { key: 'nifty200', symbol: 'NIFTY_200.NS', label: 'NIFTY 200', fallbackPrice: 12456.35, fallbackChangePercent: 0.08 },
  { key: 'niftypsubank', symbol: '^NIFTYPSU', label: 'PSU BANK', fallbackPrice: 6842.5, fallbackChangePercent: -0.42 },
  { key: 'niftypse', symbol: '^CNXPSE', label: 'NIFTY PSE', fallbackPrice: 10234.8, fallbackChangePercent: -0.33 },
  { key: 'niftyinfra', symbol: '^CNXINFRA', label: 'NIFTY INFRA', fallbackPrice: 8912.7, fallbackChangePercent: 0.24 },
  { key: 'niftyenergy', symbol: '^CNXENERGY', label: 'NIFTY ENERGY', fallbackPrice: 39874.25, fallbackChangePercent: -0.11 },
  { key: 'niftyprivatebank', symbol: '^NIFTYPVTBANK', label: 'PVT BANK', fallbackPrice: 24836.1, fallbackChangePercent: 0.19 },
  { key: 'niftyit', symbol: '^CNXIT', label: 'NIFTY IT', fallbackPrice: 35842.6, fallbackChangePercent: 0.18 },
  { key: 'niftyauto', symbol: '^CNXAUTO', label: 'NIFTY AUTO', fallbackPrice: 21984.35, fallbackChangePercent: -0.12 },
  { key: 'niftypharma', symbol: '^CNXPHARMA', label: 'NIFTY PHARMA', fallbackPrice: 18642.8, fallbackChangePercent: 0.42 },
  { key: 'niftyfmcg', symbol: '^CNXFMCG', label: 'NIFTY FMCG', fallbackPrice: 54873.55, fallbackChangePercent: 0.07 },
  { key: 'niftymetal', symbol: '^CNXMETAL', label: 'NIFTY METAL', fallbackPrice: 8342.4, fallbackChangePercent: -0.56 },
  { key: 'niftyrealty', symbol: '^CNXREALTY', label: 'NIFTY REALTY', fallbackPrice: 918.2, fallbackChangePercent: -0.21 },
];

async function fetchIndexQuotes() {
  const results = await Promise.all(
    INDEX_CATALOG.map(async (item) => {
      try {
        const response = await fetchLiveQuote(item.symbol);
        return {
          key: item.key,
          label: item.label,
          symbol: item.symbol,
          price: response.price,
          changePercent: response.changePercent,
          source: response.source,
          currency: response.currency || 'INR',
          delayed: false,
        };
      } catch {
        return {
          key: item.key,
          label: item.label,
          symbol: item.symbol,
          price: item.fallbackPrice,
          changePercent: item.fallbackChangePercent,
          source: 'fallback',
          currency: 'INR',
          delayed: true,
        };
      }
    }),
  );

  return {
    updatedAt: new Date().toISOString(),
    items: results.filter(Boolean),
  };
}

async function fetchMarketHistory(symbol, range = '6mo', interval = '1d', exchange = 'NSE') {
  try {
    return await fetchZerodhaHistory(symbol, exchange, range, interval);
  } catch {
    // fall through to Yahoo fallback when Zerodha is disconnected or unavailable
  }

  const candidates = buildYahooSymbolCandidates(symbol, exchange);
  if (candidates.length === 0) {
    throw new Error('Missing stock symbol.');
  }

  for (const candidate of candidates) {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${candidate}`);
    url.searchParams.set('range', range === 'all' ? 'max' : range);
    url.searchParams.set('interval', mapYahooInterval(interval, range));
    url.searchParams.set('includePrePost', 'false');
    url.searchParams.set('events', 'div,splits');

    const response = await fetch(url, { headers: YAHOO_HEADERS });
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const timestamps = result?.timestamp || [];

    if (!response.ok || !result || !quote || timestamps.length === 0) {
      continue;
    }

    const points = timestamps
      .map((timestamp, index) => {
        const close = Number(quote.close?.[index]);
        const open = Number(quote.open?.[index]);
        const high = Number(quote.high?.[index]);
        const low = Number(quote.low?.[index]);

        if (![open, high, low, close].every(Number.isFinite)) return null;

        return {
          date: new Date(timestamp * 1000).toISOString(),
          open,
          high,
          low,
          close,
          volume: Number(quote.volume?.[index] || 0),
        };
      })
      .filter(Boolean);

    if (points.length === 0) {
      continue;
    }

    return {
      symbol: candidate,
      marketSymbol: candidate,
      currency: result?.meta?.currency || 'INR',
      exchange: result?.meta?.exchangeName || '',
      source: 'yahoo',
      points,
    };
  }

  throw new Error(`No chart history available for ${candidates.join(', ')}.`);
}

function trimTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeBacktestHoldings(holdings = []) {
  return holdings
    .map((holding) => {
      const symbol = String(holding?.symbol || holding?.tradingsymbol || '').trim().toUpperCase();
      if (!symbol) return null;

      return {
        symbol,
        name: String(holding?.name || holding?.company_name || symbol).trim(),
        exchange: String(holding?.exchange || 'NSE').trim().toUpperCase() || 'NSE',
        quantity: Number(holding?.quantity || 0),
        buyPrice: Number(holding?.buy_price || holding?.average_price || holding?.current_price || 0),
        currentPrice: Number(holding?.current_price || holding?.last_price || holding?.buy_price || 0),
      };
    })
    .filter(Boolean);
}

function normalizeCustomTestingSymbols(symbols = []) {
  return symbols
    .map((entry) => {
      if (typeof entry === 'string') {
        const symbol = String(entry || '').trim().toUpperCase();
        if (!symbol) return null;
        return {
          symbol,
          name: symbol,
          exchange: 'NSE',
        };
      }

      const symbol = String(entry?.symbol || entry?.tradingsymbol || entry?.ticker || '').trim().toUpperCase();
      if (!symbol) return null;

      return {
        symbol,
        name: String(entry?.name || entry?.company_name || symbol).trim(),
        exchange: String(entry?.exchange || 'NSE').trim().toUpperCase() || 'NSE',
      };
    })
    .filter(Boolean);
}

function normalizeSmaPeriod(value, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(200, Math.max(10, parsed));
}

function normalizeComparisonOperator(value) {
  const normalized = String(value || '').trim();
  return ['<', '>', '='].includes(normalized) ? normalized : '>';
}

function formatSmaRuleLabel(periods = [], operators = []) {
  const [first = 20, second = 50, third = 100] = periods;
  const [op1 = '>', op2 = '>'] = operators;
  return `SMA${first} ${op1} SMA${second} ${op2} SMA${third}`;
}

function compareWithOperator(left, operator, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const tolerance = Math.max(0.01, Math.abs(right) * 0.0025);
  if (operator === '<') return left < right;
  if (operator === '>') return left > right;
  return Math.abs(left - right) <= tolerance;
}

function evaluateRuleStateAtIndex(smaSeries = [], operators = [], index = -1) {
  if (index < 0) return null;

  const values = smaSeries.map((series) => series[index]);
  if (!values.every((value) => Number.isFinite(value))) return null;

  const firstComparison = compareWithOperator(values[0], operators[0], values[1]);
  const secondComparison = compareWithOperator(values[1], operators[1], values[2]);
  return firstComparison && secondComparison;
}

function evaluateCustomSmaRule(points = [], periods = [], operators = []) {
  const closes = points.map((point) => Number(point.close || 0));
  const normalizedPeriods = [
    normalizeSmaPeriod(periods[0], 20),
    normalizeSmaPeriod(periods[1], 50),
    normalizeSmaPeriod(periods[2], 100),
  ];
  const normalizedOperators = [
    normalizeComparisonOperator(operators[0]),
    normalizeComparisonOperator(operators[1]),
  ];
  const smaSeries = normalizedPeriods.map((period) => movingAverageSeries(closes, period));

  let latestIndex = -1;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const price = closes[index];
    if (!Number.isFinite(price) || price <= 0) continue;
    const values = smaSeries.map((series) => series[index]);
    if (values.every((value) => Number.isFinite(value))) {
      latestIndex = index;
      break;
    }
  }

  let lastCrossoverIndex = -1;
  let previousState = null;
  for (let index = 0; index < points.length; index += 1) {
    const state = evaluateRuleStateAtIndex(smaSeries, normalizedOperators, index);
    if (state === null) continue;

    if (previousState === false && state === true) {
      lastCrossoverIndex = index;
    }

    previousState = state;
  }

  if (latestIndex < 0) {
    return {
      passed: false,
      latestIndex: -1,
      latestDate: null,
      lastCrossoverDate: null,
      latestClose: null,
      smaValues: [],
      expression: formatSmaRuleLabel(normalizedPeriods, normalizedOperators),
      reason: 'Not enough history to calculate all SMA values.',
    };
  }

  const latestClose = closes[latestIndex];
  const smaValues = smaSeries.map((series) => Number(series[latestIndex] || 0));
  const firstComparison = compareWithOperator(smaValues[0], normalizedOperators[0], smaValues[1]);
  const secondComparison = compareWithOperator(smaValues[1], normalizedOperators[1], smaValues[2]);
  const passed = firstComparison && secondComparison;

  const crossoverPrice = lastCrossoverIndex >= 0 ? closes[lastCrossoverIndex] : null;
  const priceChangeFromCrossoverPercent = crossoverPrice && latestClose
    ? ((latestClose - crossoverPrice) / crossoverPrice) * 100
    : null;

  return {
    passed,
    latestIndex,
    latestDate: points[latestIndex]?.date || null,
    lastCrossoverDate: lastCrossoverIndex >= 0 ? points[lastCrossoverIndex]?.date || null : null,
    lastCrossoverPrice: crossoverPrice,
    priceChangeFromCrossoverPercent,
    latestClose,
    smaValues,
    expression: formatSmaRuleLabel(normalizedPeriods, normalizedOperators),
    reason: passed ? 'Rule matched on the latest available bar.' : 'Rule did not match on the latest available bar.',
  };
}

function movingAverageSeries(values = [], length = 20) {
  const output = new Array(values.length).fill(null);
  if (values.length < length) return output;

  let rolling = 0;
  for (let index = 0; index < values.length; index += 1) {
    rolling += values[index];
    if (index >= length) {
      rolling -= values[index - length];
    }
    if (index >= length - 1) {
      output[index] = rolling / length;
    }
  }
  return output;
}

function calculateReturnPercent(startValue, endValue) {
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue) || startValue <= 0) return 0;
  return ((endValue - startValue) / startValue) * 100;
}

function buildBenchmarkMap(points = []) {
  return new Map(points.map((point) => [point.date, Number(point.close || 0)]));
}

function runSequentialBacktest(points = [], benchmarkPoints = [], settings = {}) {
  const closes = points.map((point) => Number(point.close || 0));
  const benchmarkMap = buildBenchmarkMap(benchmarkPoints);
  const fastWindow = Math.max(2, Number(settings.fastWindow || BACKTEST_FAST_WINDOW));
  const slowWindow = Math.max(fastWindow + 1, Number(settings.slowWindow || BACKTEST_SLOW_WINDOW));
  const initialCash = Math.max(1, Number(settings.initialCash || BACKTEST_INITIAL_CASH));
  const commissionRate = Math.max(0, Number(settings.commissionBps || BACKTEST_COMMISSION_BPS)) / 10000;
  const fastSeries = movingAverageSeries(closes, fastWindow);
  const slowSeries = movingAverageSeries(closes, slowWindow);
  const firstClose = closes.find((value) => Number.isFinite(value) && value > 0) || 0;
  const benchmarkStart = benchmarkPoints.find((point) => Number(point.close || 0) > 0)?.close || 0;
  let cash = initialCash;
  let shares = 0;
  let entryCash = 0;
  let tradeEntries = 0;
  let completedTrades = 0;
  let profitableTrades = 0;
  let peakEquity = initialCash;
  let maxDrawdown = 0;
  const curve = [];

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const price = Number(point.close || 0);
    if (!Number.isFinite(price) || price <= 0) continue;

    const fast = fastSeries[index];
    const slow = slowSeries[index];
    const prevFast = fastSeries[index - 1];
    const prevSlow = slowSeries[index - 1];
    const hasSignal = Number.isFinite(fast) && Number.isFinite(slow) && Number.isFinite(prevFast) && Number.isFinite(prevSlow);
    const buySignal = hasSignal && prevFast <= prevSlow && fast > slow;
    const sellSignal = hasSignal && prevFast >= prevSlow && fast < slow;

    if (buySignal && shares === 0) {
      const buyPower = cash * (1 - commissionRate);
      shares = buyPower / price;
      entryCash = cash;
      cash = 0;
      tradeEntries += 1;
    } else if (sellSignal && shares > 0) {
      const exitValue = shares * price * (1 - commissionRate);
      const tradePnL = exitValue - entryCash;
      if (tradePnL > 0) profitableTrades += 1;
      completedTrades += 1;
      cash = exitValue;
      shares = 0;
      entryCash = 0;
    }

    const equity = cash + (shares * price);
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
    }

    const benchmarkClose = benchmarkMap.get(point.date) || 0;
    const benchmarkValue = benchmarkStart > 0 && benchmarkClose > 0
      ? initialCash * (benchmarkClose / benchmarkStart)
      : null;

    curve.push({
      date: point.date,
      equity,
      benchmark: benchmarkValue,
      price,
      signal: buySignal ? 'BUY' : sellSignal ? 'SELL' : shares > 0 ? 'HOLD' : 'WAIT',
    });
  }

  const finalPrice = closes.filter((value) => Number.isFinite(value) && value > 0).at(-1) || 0;
  const finalEquity = cash + (shares * finalPrice);
  const benchmarkFinal = benchmarkPoints.filter((point) => Number(point.close || 0) > 0).at(-1)?.close || 0;

  return {
    strategyReturnPercent: calculateReturnPercent(initialCash, finalEquity),
    buyHoldReturnPercent: calculateReturnPercent(firstClose, finalPrice),
    benchmarkReturnPercent: benchmarkStart > 0 && benchmarkFinal > 0
      ? calculateReturnPercent(benchmarkStart, benchmarkFinal)
      : 0,
    maxDrawdownPercent: maxDrawdown * 100,
    winRatePercent: completedTrades > 0 ? (profitableTrades / completedTrades) * 100 : 0,
    trades: tradeEntries,
    tradeEntries,
    completedTrades,
    finalEquity,
    curve,
    lastSignal: curve.at(-1)?.signal || 'WAIT',
  };
}

async function summarizeBacktestsWithOllama(payload) {
  const baseUrl = trimTrailingSlash(OLLAMA_BASE_URL);
  if (!baseUrl) return null;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 12000) : null;

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller?.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { temperature: 0.2 },
        prompt: [
          'You are writing a concise portfolio backtest summary.',
          'Summarize the results in 2 to 3 short sentences.',
          'Mention the strongest stock, the weakest stock, and whether the system outperformed buy-and-hold overall.',
          `Data: ${JSON.stringify(payload)}`,
        ].join('\n'),
      }),
    });

    const data = await response.json().catch(() => null);
    const text = String(data?.response || '').trim();
    return text || null;
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function runVectorbtBacktest(points = [], benchmarkPoints = [], settings = {}) {
  if (!points.length) return null;

  const scriptPath = resolve(projectRoot, 'server/vectorbt_backtest.py');
  if (!existsSync(scriptPath)) return null;

  const payload = {
    points,
    benchmarkPoints,
    settings: {
      fastWindow: Number(settings.fastWindow || BACKTEST_FAST_WINDOW),
      slowWindow: Number(settings.slowWindow || BACKTEST_SLOW_WINDOW),
      initialCash: Number(settings.initialCash || BACKTEST_INITIAL_CASH),
      commissionBps: Number(settings.commissionBps || BACKTEST_COMMISSION_BPS),
    },
  };

  const result = spawnSync(PYTHON_BIN, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout) return null;

  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed?.error) return null;
    return parsed;
  } catch {
    return null;
  }
}

const NSE_INDEX_SECTORS = [
  { symbol: 'NIFTY 50', name: 'Nifty 50', color: '#000000' },
  { symbol: 'NIFTY BANK', name: 'Bank Nifty', color: '#2196F3' },
  { symbol: 'NIFTY IT', name: 'IT', color: '#00BCD4' },
  { symbol: 'NIFTY AUTO', name: 'Auto', color: '#2196F3' },
  { symbol: 'NIFTY PHARMA', name: 'Pharma', color: '#E91E63' },
  { symbol: 'NIFTY FMCG', name: 'FMCG', color: '#8BC34A' },
  { symbol: 'NIFTY METAL', name: 'Metal', color: '#795548' },
  { symbol: 'NIFTY REALTY', name: 'Realty', color: '#009688' },
  { symbol: 'NIFTY ENERGY', name: 'Energy', color: '#FF5722' },
  { symbol: 'NIFTY INFRA', name: 'Infra', color: '#9E9E9E' },
  { symbol: 'NIFTY MEDIA', name: 'Media', color: '#F7931A' },
  { symbol: 'NIFTY PSU BANK', name: 'PSU Bank', color: '#FF9800' },
  { symbol: 'NIFTY PVT BANK', name: 'Pvt Bank', color: '#9C27B0' },
  { symbol: 'NIFTY COMMODITIES', name: 'Commodities', color: '#FFEB3B' },
];

function runRrgCalculator(data, benchmark, tailLength) {
  const scriptPath = resolve(projectRoot, 'server/rrg_calculator.py');
  if (!existsSync(scriptPath)) {
    throw new Error('RRG calculator script not found.');
  }

  const payload = { data, benchmark, tailLength };
  const result = spawnSync(PYTHON_BIN, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 15 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout) {
    throw new Error(result.stderr || 'RRG calculator failed.');
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Invalid JSON from RRG calculator.');
  }
}

const server = createServer(async (req, res) => {
  if (!req.url) return sendJson(res, 400, { error: 'Missing URL.' });
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/rrg') {
      const benchmark = url.searchParams.get('benchmark') || 'NIFTY 50';
      const tailLength = Number(url.searchParams.get('tail')) || 8;

      const allSymbols = [...new Set([benchmark, ...NSE_INDEX_SECTORS.map((s) => s.symbol)])];
      const dataMap = {};

      await Promise.all(
        allSymbols.map(async (symbol) => {
          try {
            const history = await fetchMarketHistory(symbol, '2y', '1d', 'NSE');
            if (history?.points) {
              const prices = {};
              history.points.forEach((p) => {
                prices[p.date] = p.close;
              });
              dataMap[symbol] = prices;
            }
          } catch (err) {
            console.error(`Failed to fetch history for RRG symbol ${symbol}:`, err.message);
          }
        }),
      );

      try {
        const result = runRrgCalculator(dataMap, benchmark, tailLength);
        
        // Attach metadata (colors and names) to the result
        const enhancedSectors = {};
        Object.entries(result.sectors).forEach(([sym, rrg]) => {
          const meta = NSE_INDEX_SECTORS.find(s => s.symbol === sym) || { name: sym, color: '#9E9E9E' };
          enhancedSectors[sym] = {
            ...rrg,
            symbol: sym,
            name: meta.name,
            color: meta.color,
          };
        });
        
        return sendJson(res, 200, {
          ...result,
          sectors: enhancedSectors,
        });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/backtest/portfolio') {
      const rawBody = await readRequestBody(req);
      let body = {};
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        body = {};
      }

      const holdings = normalizeBacktestHoldings(body.holdings || []);
      const requestedEngine = BACKTEST_ENGINE === 'vectorbt' ? 'vectorbt' : 'sma-js';
      if (!holdings.length) {
        return sendJson(res, 200, {
          items: [],
          summary: {
            portfolioStrategyReturnPercent: 0,
            averageStrategyReturnPercent: 0,
            winRatePercent: 0,
            maxDrawdownPercent: 0,
            bestSymbol: null,
            worstSymbol: null,
          },
          integrations: {
            ollama: Boolean(trimTrailingSlash(OLLAMA_BASE_URL)),
            firecrawl: isFirecrawlConfigured(),
            engine: requestedEngine,
          },
        });
      }

      const range = String(body.range || BACKTEST_RANGE || '2y').trim() || BACKTEST_RANGE;
      const settings = {
        fastWindow: Number(body.fastWindow || BACKTEST_FAST_WINDOW),
        slowWindow: Number(body.slowWindow || BACKTEST_SLOW_WINDOW),
        initialCash: Number(body.initialCash || BACKTEST_INITIAL_CASH),
        commissionBps: Number(body.commissionBps || BACKTEST_COMMISSION_BPS),
      };

      let benchmarkPoints = [];
      try {
        const benchmark = await fetchMarketHistory(BACKTEST_BENCHMARK_SYMBOL, range, '1d', 'NSE');
        benchmarkPoints = benchmark?.points || [];
      } catch {
        benchmarkPoints = [];
      }

      const items = [];
      for (const holding of holdings) {
        try {
          const [historyResult, firecrawlResult] = await Promise.allSettled([
            fetchMarketHistory(holding.symbol, range, '1d', holding.exchange || 'NSE'),
            fetchFirecrawlContext(holding.symbol, holding.name, holding.exchange || 'NSE'),
          ]);

          const history = historyResult.status === 'fulfilled' ? historyResult.value : null;
          const newsContext = firecrawlResult.status === 'fulfilled' ? firecrawlResult.value : null;
          if (!history?.points?.length) {
            throw new Error('History feed unavailable.');
          }
          const vectorbtResult = BACKTEST_ENGINE === 'vectorbt'
            ? runVectorbtBacktest(history.points || [], benchmarkPoints, settings)
            : null;
          const result = vectorbtResult || runSequentialBacktest(history.points || [], benchmarkPoints, settings);
          items.push({
            symbol: holding.symbol,
            name: holding.name,
            exchange: holding.exchange,
            quantity: holding.quantity,
            currentPrice: holding.currentPrice || history.points?.at(-1)?.close || 0,
            historyPoints: history.points?.length || 0,
            engine: vectorbtResult ? 'vectorbt' : 'sma-js',
            newsContext,
            ...result,
            curve: (result?.curve || []).slice(-90),
          });
        } catch (error) {
          items.push({
            symbol: holding.symbol,
            name: holding.name,
            exchange: holding.exchange,
            quantity: holding.quantity,
            currentPrice: holding.currentPrice || 0,
            historyPoints: 0,
            error: error.message || 'Backtest failed.',
          });
        }
      }

      const successfulItems = items.filter((item) => !item.error);
      const strategyAverage = successfulItems.length
        ? successfulItems.reduce((sum, item) => sum + Number(item.strategyReturnPercent || 0), 0) / successfulItems.length
        : 0;
      const winRateAverage = successfulItems.length
        ? successfulItems.reduce((sum, item) => sum + Number(item.winRatePercent || 0), 0) / successfulItems.length
        : 0;
      const drawdownMax = successfulItems.length
        ? Math.max(...successfulItems.map((item) => Number(item.maxDrawdownPercent || 0)))
        : 0;
      const bestItem = [...successfulItems].sort((left, right) => Number(right.strategyReturnPercent || 0) - Number(left.strategyReturnPercent || 0))[0] || null;
      const worstItem = [...successfulItems].sort((left, right) => Number(left.strategyReturnPercent || 0) - Number(right.strategyReturnPercent || 0))[0] || null;
      const actualEngine = successfulItems.some((item) => item.engine === 'vectorbt') ? 'vectorbt' : 'sma-js';
      const aiSummary = await summarizeBacktestsWithOllama({
        holdings: successfulItems.slice(0, 6).map((item) => ({
          symbol: item.symbol,
          name: item.name,
          strategyReturnPercent: Number(item.strategyReturnPercent || 0).toFixed(2),
          buyHoldReturnPercent: Number(item.buyHoldReturnPercent || 0).toFixed(2),
          winRatePercent: Number(item.winRatePercent || 0).toFixed(2),
          maxDrawdownPercent: Number(item.maxDrawdownPercent || 0).toFixed(2),
          newsContext: item.newsContext || null,
        })),
        summary: {
          portfolioStrategyReturnPercent: strategyAverage,
          buyHoldAveragePercent: successfulItems.length
            ? successfulItems.reduce((sum, item) => sum + Number(item.buyHoldReturnPercent || 0), 0) / successfulItems.length
            : 0,
          benchmarkAveragePercent: successfulItems.length
            ? successfulItems.reduce((sum, item) => sum + Number(item.benchmarkReturnPercent || 0), 0) / successfulItems.length
            : 0,
        },
      });

      return sendJson(res, 200, {
        range,
        settings,
        items,
        summary: {
          portfolioStrategyReturnPercent: strategyAverage,
          averageStrategyReturnPercent: strategyAverage,
          averageBuyHoldReturnPercent: successfulItems.length
            ? successfulItems.reduce((sum, item) => sum + Number(item.buyHoldReturnPercent || 0), 0) / successfulItems.length
            : 0,
          averageBenchmarkReturnPercent: successfulItems.length
            ? successfulItems.reduce((sum, item) => sum + Number(item.benchmarkReturnPercent || 0), 0) / successfulItems.length
            : 0,
          winRatePercent: winRateAverage,
          maxDrawdownPercent: drawdownMax,
          bestSymbol: bestItem?.symbol || null,
          worstSymbol: worstItem?.symbol || null,
          aiSummary,
        },
        integrations: {
          ollama: Boolean(trimTrailingSlash(OLLAMA_BASE_URL)),
          firecrawl: isFirecrawlConfigured(),
          engine: actualEngine,
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/backtest/custom') {
      const rawBody = await readRequestBody(req);
      let body = {};
      try {
        body = JSON.parse(rawBody || '{}');
      } catch {
        body = {};
      }

      const strategy = String(body.strategy || 'sma').trim().toLowerCase();
      if (strategy !== 'sma') {
        return sendJson(res, 400, { error: 'Only the SMA custom test strategy is supported right now.' });
      }

      const symbols = normalizeCustomTestingSymbols(body.symbols || body.holdings || []);
      if (!symbols.length) {
        return sendJson(res, 200, {
          strategy: 'sma',
          symbols: [],
          items: [],
          summary: {
            passCount: 0,
            failCount: 0,
            passRatePercent: 0,
            bestSymbol: null,
            worstSymbol: null,
          },
          rules: {
            periods: [20, 50, 100],
            operators: ['>', '>'],
            expression: formatSmaRuleLabel([20, 50, 100], ['>', '>']),
          },
        });
      }

      const periods = [
        normalizeSmaPeriod(body.period1 || body.periods?.[0], 20),
        normalizeSmaPeriod(body.period2 || body.periods?.[1], 50),
        normalizeSmaPeriod(body.period3 || body.periods?.[2], 100),
      ];
      const operators = [
        normalizeComparisonOperator(body.operator1 || body.operators?.[0]),
        normalizeComparisonOperator(body.operator2 || body.operators?.[1]),
      ];
      const range = String(body.range || '6mo').trim() || '6mo';

      const items = [];
      for (const symbolEntry of symbols) {
        try {
          const history = await fetchMarketHistory(symbolEntry.symbol, range, '1d', symbolEntry.exchange || 'NSE');
          const points = history?.points || [];
          if (!points.length) {
            throw new Error('History feed unavailable.');
          }

          const evaluation = evaluateCustomSmaRule(points, periods, operators);
          const latestPoint = points[evaluation.latestIndex] || null;
          items.push({
            symbol: symbolEntry.symbol,
            name: symbolEntry.name,
            exchange: symbolEntry.exchange,
            historyPoints: points.length,
            range,
            strategy: 'sma',
            ...evaluation,
            latestDate: evaluation.latestDate || latestPoint?.date || null,
            latestClose: evaluation.latestClose || latestPoint?.close || null,
            smaValues: evaluation.smaValues.map((value, index) => ({
              period: periods[index],
              value,
            })),
          });
        } catch (error) {
          items.push({
            symbol: symbolEntry.symbol,
            name: symbolEntry.name,
            exchange: symbolEntry.exchange,
            historyPoints: 0,
            range,
            strategy: 'sma',
            error: error.message || 'Custom SMA test failed.',
          });
        }
      }

      const successfulItems = items.filter((item) => !item.error);
      const passCount = successfulItems.filter((item) => item.passed).length;
      const failCount = successfulItems.length - passCount;
      const passRatePercent = successfulItems.length ? (passCount / successfulItems.length) * 100 : 0;
      const bestItem = successfulItems.find((item) => item.passed) || null;
      const worstItem = successfulItems.find((item) => !item.passed) || null;

      if (body.telegramAlerts && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        const passedSymbols = successfulItems.filter((i) => i.passed).map((i) => i.symbol);
        if (passedSymbols.length > 0) {
          const message = [
            '<b>🚀 SMA Alert Triggered</b>',
            `Rule: ${formatSmaRuleLabel(periods, operators)}`,
            `Range: ${range}`,
            '',
            `<b>Symbols Passed (${passedSymbols.length}):</b>`,
            passedSymbols.map((s) => `• ${s}`).join('\n'),
            '',
            `<a href="${FRONTEND_URL}">View Dashboard</a>`,
          ].join('\n');
          await sendTelegramMessage(message);
        }
      }

      return sendJson(res, 200, {
        strategy: 'sma',
        symbols,
        items,
        summary: {
          passCount,
          failCount,
          passRatePercent,
          bestSymbol: bestItem?.symbol || null,
          worstSymbol: worstItem?.symbol || null,
        },
        rules: {
          periods,
          operators,
          expression: formatSmaRuleLabel(periods, operators),
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/zerodha/postback') {
      const rawBody = await readRequestBody(req);
      const contentType = req.headers['content-type'] || '';
      let payload = { raw: rawBody };

      if (contentType.includes('application/json')) {
        try {
          payload = JSON.parse(rawBody || '{}');
        } catch {
          payload = { raw: rawBody };
        }
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        payload = Object.fromEntries(new URLSearchParams(rawBody));
      }

      logPostback(payload);
      return sendJson(res, 200, { success: true, received: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/market/quote') {
      const symbol = url.searchParams.get('symbol') || '';
      const exchange = url.searchParams.get('exchange') || 'NSE';
      const quote = await fetchLiveQuote(symbol, exchange);
      return sendJson(res, 200, quote);
    }

    if (req.method === 'GET' && url.pathname === '/api/market/indices') {
      const payload = await fetchIndexQuotes();
      return sendJson(res, 200, payload);
    }

    if (req.method === 'GET' && url.pathname === '/api/market/search') {
      const query = url.searchParams.get('q') || '';
      const limit = url.searchParams.get('limit') || '12';
      const items = await searchMarketSymbols(query, limit);
      return sendJson(res, 200, { items });
    }

    if (req.method === 'GET' && url.pathname === '/api/market/history') {
      const symbol = url.searchParams.get('symbol') || '';
      const range = url.searchParams.get('range') || '6mo';
      const interval = url.searchParams.get('interval') || '1d';
      const exchange = url.searchParams.get('exchange') || 'NSE';
      const history = await fetchMarketHistory(symbol, range, interval, exchange);
      return sendJson(res, 200, history);
    }

    if (req.method === 'GET' && url.pathname === '/api/company/intelligence') {
      const symbol = url.searchParams.get('symbol') || '';
      const intelligence = await fetchCompanyIntelligence(symbol);
      return sendJson(res, 200, intelligence);
    }

    if (req.method === 'GET' && url.pathname === '/api/options/chain') {
      const symbol = url.searchParams.get('symbol') || '';
      const exchange = url.searchParams.get('exchange') || 'NSE';
      const expiry = url.searchParams.get('expiry') || '';
      const strikeCount = url.searchParams.get('strikeCount') || '9';
      const chain = await fetchZerodhaOptionChain(symbol, exchange, expiry, strikeCount);
      return sendJson(res, 200, chain);
    }

    if (req.method === 'GET' && url.pathname === '/api/futures/board') {
      const symbol = url.searchParams.get('symbol') || '';
      const exchange = url.searchParams.get('exchange') || 'NSE';
      const board = await fetchZerodhaFuturesBoard(symbol, exchange);
      return sendJson(res, 200, board);
    }

    if (req.method === 'GET' && url.pathname === '/api/zerodha/status') {
      const session = await readSession();
      return sendJson(res, 200, {
        configured: Boolean(API_KEY && API_SECRET),
        connected: Boolean(session?.access_token),
        profile: session ? {
          user_id: session.user_id,
          user_name: session.user_name,
          email: session.email,
          login_time: session.login_time,
        } : null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/zerodha/login-url') {
      if (!API_KEY || !API_SECRET) {
        return sendJson(res, 400, { error: 'ZERODHA_API_KEY and ZERODHA_API_SECRET must be set in .env.' });
      }
      const platform = url.searchParams.get('platform') === 'native' ? 'native' : 'web';
      writeAuthContext({
        platform,
        frontend_url: platform === 'web' ? getRequestFrontendOrigin(req) : null,
        created_at: new Date().toISOString(),
      });
      return sendJson(res, 200, {
        loginUrl: getLoginUrl(),
        redirectUri: REDIRECT_URI,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/zerodha/callback') {
      const requestToken = url.searchParams.get('request_token');
      const authContext = readAuthContext();
      const redirectTarget = authContext?.platform === 'native' ? 'native' : 'web';
      const frontendUrl = authContext?.frontend_url || FRONTEND_URL;
      clearAuthContext();
      if (!requestToken) {
        return redirect(res, buildFrontendRedirect('error', 'missing_request_token', redirectTarget, frontendUrl));
      }

      try {
        await exchangeRequestToken(requestToken);
        return redirect(res, buildFrontendRedirect('connected', null, redirectTarget, frontendUrl));
      } catch (error) {
        return redirect(res, buildFrontendRedirect('error', error.message, redirectTarget, frontendUrl));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/test/telegram-pl') {
      try {
        const data = await kiteRequest('/portfolio/holdings');
        const holdings = data?.data || [];
        if (!holdings.length) {
          return sendJson(res, 400, { error: 'No holdings found to summarize.' });
        }

        let totalInvested = 0;
        let totalCurrentValue = 0;
        holdings.forEach((h) => {
          totalInvested += h.quantity * h.average_price;
          totalCurrentValue += h.quantity * h.last_price;
        });

        const totalPL = totalCurrentValue - totalInvested;
        const plPercent = (totalPL / totalInvested) * 100;

        const message = [
          '<b>💰 Portfolio P&L Test Alert</b>',
          '',
          `Total Invested: ₹${totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
          `Current Value: ₹${totalCurrentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
          '',
          `<b>Overall P&L: ${totalPL >= 0 ? '🟢' : '🔴'} ₹${totalPL.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</b>`,
          `Percentage: ${plPercent.toFixed(2)}%`,
          '',
          `<a href="${FRONTEND_URL}">Open Dashboard</a>`,
        ].join('\n');

        const result = await sendTelegramMessage(message);
        return sendJson(res, 200, { success: true, telegramResponse: result });
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/zerodha/holdings') {
      const data = await kiteRequest('/portfolio/holdings');
      return sendJson(res, 200, data);
    }

    if (req.method === 'GET' && url.pathname === '/api/zerodha/positions') {
      const data = await kiteRequest('/portfolio/positions');
      return sendJson(res, 200, data);
    }

    if (req.method === 'GET' && url.pathname === '/api/zerodha/orders') {
      const data = await kiteRequest('/orders');
      return sendJson(res, 200, data);
    }

    if (req.method === 'POST' && url.pathname === '/api/zerodha/orders') {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || '{}');
      const tradingsymbol = String(payload.tradingsymbol || payload.contractSymbol || '').trim().toUpperCase();
      const exchange = String(payload.exchange || 'NFO').trim().toUpperCase();
      const transaction_type = String(payload.transaction_type || payload.side || '').trim().toUpperCase();
      const order_type = String(payload.order_type || payload.orderType || 'MARKET').trim().toUpperCase();
      const product = String(payload.product || 'NRML').trim().toUpperCase();
      const validity = String(payload.validity || 'DAY').trim().toUpperCase();
      const quantity = Number(payload.quantity || 0);
      const price = Number(payload.price || 0);
      const triggerPrice = Number(payload.trigger_price || payload.triggerPrice || 0);
      const variety = String(payload.variety || 'regular').trim().toLowerCase();

      if (!tradingsymbol || !transaction_type || !quantity) {
        return sendJson(res, 400, { error: 'tradingsymbol, transaction_type, and quantity are required.' });
      }

      const body = new URLSearchParams({
        exchange,
        tradingsymbol,
        transaction_type,
        order_type,
        product,
        validity,
        quantity: String(quantity),
      });

      if (order_type !== 'MARKET' && price > 0) {
        body.set('price', String(price));
      }
      if ((order_type === 'SL' || order_type === 'SL-M') && triggerPrice > 0) {
        body.set('trigger_price', String(triggerPrice));
      }

      const data = await kiteRequest(`/orders/${encodeURIComponent(variety)}`, {
        method: 'POST',
        body,
      });
      return sendJson(res, 200, {
        success: true,
        order_id: data?.data?.order_id || null,
        response: data?.data || data,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/zerodha/margins') {
      const data = await kiteRequest('/user/margins');
      return sendJson(res, 200, data);
    }

    if (req.method === 'POST' && url.pathname === '/api/zerodha/disconnect') {
      await clearSession();
      return sendJson(res, 200, { success: true });
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`Broker server listening on http://localhost:${PORT}`);
  console.log(`Configured redirect URI: ${REDIRECT_URI}`);
  console.log('Session storage: file');

  // Start background alert monitoring
  setInterval(checkPortfolioAlerts, ALERT_MONITOR_INTERVAL);
  // Run once on startup
  setTimeout(checkPortfolioAlerts, 10000);

  // Start Telegram bot polling
  if (TELEGRAM_BOT_TOKEN) {
    console.log('Starting Telegram bot polling...');
    pollTelegramUpdates();
  }
});
