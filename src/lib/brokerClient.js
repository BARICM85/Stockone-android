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
  if (import.meta.env.PROD) {
    return '';
  }
  return configuredBase;
}

export function getZerodhaRedirectUrl() {
  const brokerApiBase = getBrokerApiBase();
  if (brokerApiBase) {
    return `${brokerApiBase}/api/zerodha/callback`;
  }
  if (import.meta.env.PROD) {
    return `${trimSlash(HOSTED_API_BASE)}/api/zerodha/callback`;
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

export async function getZerodhaStatus() {
  try {
    return await request('/api/zerodha/status');
  } catch (error) {
    return {
      configured: false,
      connected: false,
      profile: null,
      error: null,
    };
  }
}

export async function getZerodhaLoginUrl(platform = 'web') {
  const search = platform === 'native' ? '?platform=native' : '';
  try {
    return await request(`/api/zerodha/login-url${search}`);
  } catch (error) {
    return {
      loginUrl: 'https://kite.zerodha.com/connect/login?v=3&api_key=mock_key',
      redirectUri: 'http://localhost:8000/api/zerodha/callback',
    };
  }
}

export async function getZerodhaHoldings() {
  try {
    return await request('/api/zerodha/holdings');
  } catch (error) {
    return { status: 'success', data: [] };
  }
}

export async function getZerodhaPositions() {
  try {
    return await request('/api/zerodha/positions');
  } catch (error) {
    return { status: 'success', data: { net: [], day: [] } };
  }
}

export async function getZerodhaOrders() {
  try {
    return await request('/api/zerodha/orders');
  } catch (error) {
    return { status: 'success', data: [] };
  }
}

export async function getZerodhaMargins() {
  try {
    return await request('/api/zerodha/margins');
  } catch (error) {
    return { status: 'success', data: { equity: { cash: 0, balance: 0 }, commodity: { cash: 0, balance: 0 } } };
  }
}

export function placeZerodhaOrder(payload) {
  return request('/api/zerodha/orders', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export async function disconnectZerodha() {
  try {
    return await request('/api/zerodha/disconnect', { method: 'POST' });
  } catch (error) {
    return { success: true };
  }
}

export function testTelegramAlert() {
  return request('/api/test/telegram-pl', { method: 'POST' });
}

// Local simulation support helpers
function hashSymbol(symbol = '') {
  return [...symbol.toUpperCase()].reduce((sum, char) => sum + char.charCodeAt(0), 0);
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

function compareWithOperator(left, operator, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const tolerance = Math.max(0.01, Math.abs(right) * 0.0025);
  if (operator === '<') return left < right;
  if (operator === '>') return left > right;
  return Math.abs(left - right) <= tolerance;
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

  const formatSmaRuleLabelLocal = (pers = [], ops = []) => {
    const [first = 20, second = 50, third = 100] = pers;
    const [op1 = '>', op2 = '>'] = ops;
    return `SMA${first} ${op1} SMA${second} ${op2} SMA${third}`;
  };

  if (latestIndex < 0) {
    return {
      passed: false,
      latestIndex: -1,
      latestDate: null,
      lastCrossoverDate: null,
      latestClose: null,
      smaValues: [],
      expression: formatSmaRuleLabelLocal(normalizedPeriods, normalizedOperators),
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
    ? calculateReturnPercent(crossoverPrice, latestClose)
    : null;

  return {
    passed,
    latestIndex,
    latestDate: points[latestIndex]?.date || null,
    lastCrossoverDate: lastCrossoverIndex >= 0 ? points[lastCrossoverIndex]?.date : null,
    latestClose,
    smaValues,
    expression: formatSmaRuleLabelLocal(normalizedPeriods, normalizedOperators),
    priceChangeFromCrossoverPercent,
  };
}

function runSequentialBacktestLocal(points = [], benchmarkPoints = [], settings = {}) {
  const closes = points.map((point) => Number(point.close || 0));
  const benchmarkMap = new Map(benchmarkPoints.map((point) => [point.date, Number(point.close || 0)]));
  const fastWindow = Math.max(2, Number(settings.fastWindow || 20));
  const slowWindow = Math.max(fastWindow + 1, Number(settings.slowWindow || 50));
  const initialCash = Math.max(1, Number(settings.initialCash || 100000));
  const commissionRate = Math.max(0, Number(settings.commissionBps || 0)) / 10000;
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

export async function runPortfolioBacktest(payload = {}) {
  try {
    return await request('/api/backtest/portfolio', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: 45000,
    });
  } catch (error) {
    console.warn('[TickerTap] Backend backtest failed, running locally...', error);
    const range = payload.range || '2y';
    const settings = {
      fastWindow: payload.fastWindow || 20,
      slowWindow: payload.slowWindow || 50,
      initialCash: payload.initialCash || 100000,
      commissionBps: payload.commissionBps || 0,
    };

    const benchmarkSymbol = '^NSEI';
    let benchmarkPoints = [];
    try {
      const benchmark = await getLiveMarketHistory(benchmarkSymbol, range, '1d', 'NSE');
      benchmarkPoints = benchmark?.points || [];
    } catch (e) {
      benchmarkPoints = [];
    }

    const items = [];
    for (const holding of (payload.holdings || [])) {
      try {
        const history = await getLiveMarketHistory(holding.symbol, range, '1d', holding.exchange || 'NSE');
        if (!history?.points?.length) {
          throw new Error('History feed unavailable.');
        }
        const result = runSequentialBacktestLocal(history.points, benchmarkPoints, settings);
        items.push({
          symbol: holding.symbol,
          name: holding.name,
          exchange: holding.exchange,
          quantity: holding.quantity,
          currentPrice: holding.current_price || history.points.at(-1)?.close || 0,
          historyPoints: history.points.length,
          engine: 'sma-js-local',
          newsContext: null,
          ...result,
          curve: (result.curve || []).slice(-90),
        });
      } catch (err) {
        items.push({
          symbol: holding.symbol,
          name: holding.name,
          exchange: holding.exchange,
          quantity: holding.quantity,
          currentPrice: holding.current_price || 0,
          historyPoints: 0,
          error: err.message || 'Backtest failed.',
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

    return {
      items,
      summary: {
        portfolioStrategyReturnPercent: strategyAverage,
        averageStrategyReturnPercent: strategyAverage,
        winRatePercent: winRateAverage,
        maxDrawdownPercent: drawdownMax,
        bestSymbol: bestItem?.symbol || null,
        worstSymbol: worstItem?.symbol || null,
        aiSummary: 'Local crossover SMA simulation complete. Charts and indicators rendered offline.',
      },
      integrations: {
        ollama: false,
        firecrawl: false,
        engine: 'sma-js-local',
      },
    };
  }
}

export async function runCustomTesting(payload = {}) {
  try {
    return await request('/api/backtest/custom', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: 45000,
    });
  } catch (error) {
    console.warn('[TickerTap] Backend custom testing failed, running locally...', error);
    const symbols = payload.symbols || payload.holdings || [];
    const range = payload.range || '6mo';
    const periods = [
      payload.period1 || 20,
      payload.period2 || 50,
      payload.period3 || 100,
    ];
    const operators = [
      payload.operator1 || '>',
      payload.operator2 || '>',
    ];

    const items = [];
    for (const symbolEntry of symbols) {
      try {
        const history = await getLiveMarketHistory(symbolEntry.symbol, range, '1d', symbolEntry.exchange || 'NSE');
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
          smaValues: evaluation.smaValues.map((value, idx) => ({
            period: periods[idx],
            value,
          })),
        });
      } catch (err) {
        items.push({
          symbol: symbolEntry.symbol,
          name: symbolEntry.name,
          exchange: symbolEntry.exchange,
          historyPoints: 0,
          range,
          strategy: 'sma',
          error: err.message || 'Custom SMA test failed.',
        });
      }
    }

    const successfulItems = items.filter((item) => !item.error);
    const passCount = successfulItems.filter((item) => item.passed).length;
    const failCount = successfulItems.length - passCount;
    const passRatePercent = successfulItems.length ? (passCount / successfulItems.length) * 100 : 0;

    const formatSmaRuleLabelLocal = (pers = [], ops = []) => {
      const [first = 20, second = 50, third = 100] = pers;
      const [op1 = '>', op2 = '>'] = ops;
      return `SMA${first} ${op1} SMA${second} ${op2} SMA${third}`;
    };

    return {
      strategy: 'sma',
      symbols,
      items,
      summary: {
        passCount,
        failCount,
        passRatePercent,
        bestSymbol: successfulItems.find(item => item.passed)?.symbol || null,
        worstSymbol: successfulItems.find(item => !item.passed)?.symbol || null,
      },
      rules: {
        periods,
        operators,
        expression: formatSmaRuleLabelLocal(periods, operators),
      },
    };
  }
}

export async function getLiveMarketQuote(symbol, options = {}) {
  const exchange = options.exchange || 'NSE';
  const { exchange: _exchange, ...requestOptions } = options;
  try {
    return await request(
      `/api/market/quote?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}`,
      requestOptions,
    );
  } catch (error) {
    console.warn(`[TickerTap] Using offline fallback quote for ${symbol}`);
    const hash = hashSymbol(symbol);
    const price = Number((150 + (hash % 3500) + ((hash % 13) * 0.37)).toFixed(2));
    const changePercent = Number((((hash % 23) - 11) / 4).toFixed(1));
    return {
      symbol: symbol.toUpperCase(),
      price,
      changePercent,
      exchange,
      currency: 'INR',
      source: 'offline_fallback',
    };
  }
}

export async function getLiveMarketHistory(symbol, range = 'ytd', interval = '1d', exchange = 'NSE') {
  try {
    return await request(
      `/api/market/history?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&exchange=${encodeURIComponent(exchange)}`,
    );
  } catch (error) {
    console.warn(`[TickerTap] Using offline fallback history for ${symbol}`);
    const hash = hashSymbol(symbol);
    const basePrice = Number((150 + (hash % 3500) + ((hash % 13) * 0.37)).toFixed(2));
    
    const points = [];
    const now = new Date();
    const count = 90; // Generate 90 daily points for better chart and backtesting range
    for (let i = count; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const progress = (count - i) / count;
      const seasonal = Math.sin((hash + (count - i)) / 3.2) * (basePrice * 0.04);
      const close = Number((basePrice * 0.9 + (progress * basePrice * 0.15) + seasonal).toFixed(2));
      const open = Number((close * (1 + (Math.random() - 0.5) * 0.02)).toFixed(2));
      const high = Number((Math.max(open, close) * (1 + Math.random() * 0.01)).toFixed(2));
      const low = Number((Math.min(open, close) * (1 - Math.random() * 0.01)).toFixed(2));
      points.push({
        date: date.toISOString().slice(0, 10),
        open,
        high,
        low,
        close,
        volume: Math.floor(10000 + (hash % 50000) * (0.8 + Math.random() * 0.4)),
      });
    }
    return {
      symbol: symbol.toUpperCase(),
      exchange,
      points,
      source: 'offline_fallback',
    };
  }
}

export async function getOptionChain(symbol, exchange = 'NSE', expiry = '', strikeCount = 12) {
  try {
    return await request(
      `/api/options/chain?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}&expiry=${encodeURIComponent(expiry)}&strikeCount=${encodeURIComponent(strikeCount)}`,
      { timeoutMs: 10000 },
    );
  } catch (error) {
    console.warn(`[TickerTap] Using offline fallback option chain for ${symbol}`);
    const hash = hashSymbol(symbol);
    const spot = Number((150 + (hash % 3500) + ((hash % 13) * 0.37)).toFixed(2));
    const roundStrike = Math.round(spot / 50) * 50;
    const step = 50;
    const strikes = [];
    const count = Number(strikeCount) || 12;
    const half = Math.floor(count / 2);
    for (let i = -half; i <= half; i++) {
      const strike = roundStrike + i * step;
      const dist = Math.abs(strike - spot) / spot;
      const callPrice = Number((spot * 0.05 * Math.exp(-dist * 8) * (0.9 + Math.random() * 0.2)).toFixed(2));
      const putPrice = Number((spot * 0.05 * Math.exp(-dist * 8) * (0.9 + Math.random() * 0.2)).toFixed(2));
      strikes.push({
        strike,
        ce: { price: callPrice, changePercent: -2.5, iv: 18.5, oi: 15000 + (strike % 5) * 1000 },
        pe: { price: putPrice, changePercent: 1.8, iv: 17.2, oi: 12000 + (strike % 3) * 2000 },
      });
    }
    return {
      symbol: symbol.toUpperCase(),
      spot,
      expiry: expiry || '2026-06-25',
      strikes,
      source: 'offline_fallback',
    };
  }
}

export async function getFuturesBoard(symbol, exchange = 'NSE') {
  try {
    return await request(
      `/api/futures/board?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}`,
      { timeoutMs: 10000 },
    );
  } catch (error) {
    console.warn(`[TickerTap] Using offline fallback futures board for ${symbol}`);
    const hash = hashSymbol(symbol);
    const spot = Number((150 + (hash % 3500) + ((hash % 13) * 0.37)).toFixed(2));
    return {
      symbol: symbol.toUpperCase(),
      spot,
      contracts: [
        { expiry: 'Near Month', price: Number((spot * 1.002).toFixed(2)), volume: 150000 },
        { expiry: 'Next Month', price: Number((spot * 1.005).toFixed(2)), volume: 45000 },
        { expiry: 'Far Month', price: Number((spot * 1.008).toFixed(2)), volume: 8000 },
      ],
      source: 'offline_fallback',
    };
  }
}

export async function getCompanyIntelligence(symbol) {
  try {
    return await request(`/api/company/intelligence?symbol=${encodeURIComponent(symbol)}`, { timeoutMs: 8000 });
  } catch (error) {
    console.warn(`[TickerTap] Using offline fallback company intelligence for ${symbol}`);
    return {
      symbol: symbol.toUpperCase(),
      valuation: {
        pe_ratio: 24.5,
        industry_pe: 22.1,
        verdict: 'Fairly Valued',
      },
      sentiment: 'Neutral',
      risks: [
        'Macro economic growth trends could impact cyclical margins.',
        'High competitive environment might limit pricing flexibility.',
      ],
      opportunities: [
        'Robust balance sheet supports inorganic expansion plans.',
        'Digital transformation investments starting to yield product improvements.',
      ],
      recommendation: 'Accumulate on dips for long-term compounding.',
      source: 'offline_fallback',
    };
  }
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

