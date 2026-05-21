import { Capacitor } from '@capacitor/core';

const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_BROKER_API_URL || '';
const HOSTED_API_BASE = import.meta.env.VITE_HOSTED_API_BASE_URL || 'https://tickertap-backend-88ts.onrender.com';

function trimSlash(value = '') {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isLocalApiBase(value = '') {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(value);
}

export function getBrokerApiBase() {
  const configuredBase = trimSlash(DEFAULT_API_BASE);
  if (Capacitor.isNativePlatform() && (!configuredBase || isLocalApiBase(configuredBase))) {
    return trimSlash(HOSTED_API_BASE);
  }
  return configuredBase;
}

export function getZerodhaRedirectUrl() {
  const brokerApiBase = getBrokerApiBase();
  if (brokerApiBase) {
    return `${brokerApiBase}/api/zerodha/callback`;
  }
  return 'http://localhost:8000/api/zerodha/callback';
}

function describeHttpFailure(status, path) {
  if (status === 521) {
    return `Hosted backend unavailable (${status}) while requesting ${path}. Restart or redeploy the backend service and retry.`;
  }
  if (status === 502 || status === 503 || status === 504) {
    return `Broker backend temporarily unavailable (${status}) while requesting ${path}. Retry after the service wakes up.`;
  }
  return null;
}

async function request(path, options = {}) {
  const brokerBase = getBrokerApiBase();
  const defaultTimeoutMs = /onrender\.com/i.test(brokerBase) ? 30000 : 4500;
  const { timeoutMs = defaultTimeoutMs, ...fetchOptions } = options;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const endpoint = `${brokerBase}${path}`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        'Content-Type': 'application/json',
        ...(fetchOptions.headers || {}),
      },
      ...fetchOptions,
      signal: controller?.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const statusMessage = describeHttpFailure(response.status, path);
      throw new Error(data?.error || statusMessage || `Broker request failed (${response.status}).`);
    }
    return data;
  } catch (error) {
    const aborted = error?.name === 'AbortError' || controller?.signal?.aborted;
    if (aborted) {
      throw new Error(`Broker request timed out after ${Math.round(timeoutMs / 1000)}s. Check whether the backend is awake and reachable, then retry.`);
    }
    if (error instanceof TypeError) {
      throw new Error(`Unable to reach broker backend at ${brokerBase || endpoint}. Check network access or backend availability.`);
    }
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

export function getZerodhaStatus() {
  return request('/api/zerodha/status');
}

export function getZerodhaLoginUrl(platform = 'web') {
  const search = platform === 'native' ? '?platform=native' : '';
  return request(`/api/zerodha/login-url${search}`);
}

export function getZerodhaHoldings() {
  return request('/api/zerodha/holdings');
}

export function getZerodhaPositions() {
  return request('/api/zerodha/positions');
}

export function getZerodhaOrders() {
  return request('/api/zerodha/orders');
}

export function getZerodhaMargins() {
  return request('/api/zerodha/margins');
}

export function placeZerodhaOrder(payload) {
  return request('/api/zerodha/orders', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export function disconnectZerodha() {
  return request('/api/zerodha/disconnect', { method: 'POST' });
}

export function testTelegramAlert() {
  return request('/api/test/telegram-pl', { method: 'POST' });
}

export function runPortfolioBacktest(payload = {}) {
  return request('/api/backtest/portfolio', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 45000,
  });
}

export function runCustomTesting(payload = {}) {
  return request('/api/backtest/custom', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 45000,
  });
}

export function getLiveMarketQuote(symbol, options = {}) {
  const exchange = options.exchange || 'NSE';
  const { exchange: _exchange, ...requestOptions } = options;
  return request(
    `/api/market/quote?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}`,
    requestOptions,
  );
}

export function getLiveMarketHistory(symbol, range = 'ytd', interval = '1d', exchange = 'NSE') {
  return request(
    `/api/market/history?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&exchange=${encodeURIComponent(exchange)}`,
  );
}

export function getOptionChain(symbol, exchange = 'NSE', expiry = '', strikeCount = 12) {
  return request(
    `/api/options/chain?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(expiry)}&strikeCount=${encodeURIComponent(strikeCount)}`,
    { timeoutMs: 10000 },
  );
}

export function getFuturesBoard(symbol, exchange = 'NSE') {
  return request(
    `/api/futures/board?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}`,
    { timeoutMs: 10000 },
  );
}

export function getCompanyIntelligence(symbol) {
  return request(`/api/company/intelligence?symbol=${encodeURIComponent(symbol)}`, { timeoutMs: 8000 });
}

export async function getLiveMarketQuotes(symbols = [], options = {}) {
  const normalizedSymbols = symbols
    .map((entry) => {
      if (typeof entry === 'string') {
        const symbol = String(entry || '').trim().toUpperCase();
        return symbol ? { symbol, exchange: 'NSE' } : null;
      }

      const symbol = String(entry?.symbol || '').trim().toUpperCase();
      if (!symbol) return null;
      return {
        symbol,
        exchange: String(entry?.exchange || 'NSE').trim().toUpperCase() || 'NSE',
      };
    })
    .filter(Boolean);
  const uniqueSymbols = [...new Map(normalizedSymbols.map((entry) => [`${entry.exchange}:${entry.symbol}`, entry])).values()];
  const concurrency = Math.max(1, Math.min(options.concurrency || 6, 10));
  const results = new Map();
  const failures = [];

  for (let index = 0; index < uniqueSymbols.length; index += concurrency) {
    const batch = uniqueSymbols.slice(index, index + concurrency);
    const settled = await Promise.allSettled(
      batch.map((entry) => getLiveMarketQuote(entry.symbol, { ...options, exchange: entry.exchange })),
    );

    settled.forEach((entry, batchIndex) => {
      const batchEntry = batch[batchIndex];
      const key = `${batchEntry.exchange}:${batchEntry.symbol}`;
      if (entry.status === 'fulfilled' && Number.isFinite(Number(entry.value?.price)) && Number(entry.value.price) > 0) {
        results.set(key, entry.value);
      } else {
        failures.push(key);
      }
    });
  }

  return { results, failures };
}

export function mapZerodhaHoldingToPortfolio(holding) {
  const symbol = holding.tradingsymbol || holding.symbol;
  const exchange = String(holding.exchange || 'NSE').trim().toUpperCase() || 'NSE';
  const currentPrice = Number(holding.last_price || holding.close_price || 0);
  const averagePrice = Number(holding.average_price || holding.t1_average_price || currentPrice || 0);
  
  // Summing all relevant quantities to handle T1 and Pledged shares correctly
  // Zerodha API: quantity (settled), t1_quantity (yesterday's buy), collateral_quantity (pledged)
  const quantity = Number(holding.quantity || 0) + 
                   Number(holding.t1_quantity || 0) + 
                   Number(holding.collateral_quantity || 0);

  return {
    symbol,
    name: holding.company_name || symbol,
    sector: holding.sector || 'Broker Imported',
    quantity,
    buy_price: averagePrice || currentPrice,
    current_price: currentPrice || averagePrice,
    buy_date: new Date().toISOString().slice(0, 10),
    currency: 'INR',
    exchange,
    notes: `Imported from Zerodha ${holding.product ? `(${holding.product})` : ''}`.trim(),
  };
}

export function mapZerodhaPositionToPortfolio(position) {
  const symbol = position.tradingsymbol || position.symbol;
  const exchange = String(position.exchange || 'NSE').trim().toUpperCase() || 'NSE';
  const currentPrice = Number(position.last_price || 0);
  const averagePrice = Number(position.average_price || currentPrice || 0);
  const quantity = Number(position.quantity || 0);

  return {
    symbol,
    name: symbol,
    sector: 'Broker Position',
    quantity,
    buy_price: averagePrice || currentPrice,
    current_price: currentPrice || averagePrice,
    buy_date: new Date().toISOString().slice(0, 10),
    currency: 'INR',
    exchange,
    notes: `Imported from Zerodha Positions (${position.product || ''})`.trim(),
  };
}

export function mergeBrokerHoldings(existingStocks = [], brokerHoldings = []) {
  const indexed = new Map(existingStocks.map((stock) => [stock.symbol?.toUpperCase(), stock]));

  return brokerHoldings.map((holding) => {
    const mapped = mapZerodhaHoldingToPortfolio(holding);
    const existing = indexed.get(mapped.symbol?.toUpperCase());

    if (!existing) return mapped;

    return {
      ...existing,
      ...mapped,
      id: existing.id,
      created_date: existing.created_date,
      notes: existing.notes || mapped.notes,
    };
  });
}
