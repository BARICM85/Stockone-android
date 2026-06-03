import React, { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Loader2, LogOut, RefreshCw, Send, ShieldCheck, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import { disconnectZerodha, getBrokerApiBase, getZerodhaHoldings, getZerodhaLoginUrl, getZerodhaPositions, getZerodhaRedirectUrl, getZerodhaStatus, mapZerodhaHoldingToPortfolio, mapZerodhaPositionToPortfolio, testTelegramAlert } from '@/lib/brokerClient';

export default function BrokerSyncPanel({ currentStocks = [], onSynced }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const brokerApiBase = getBrokerApiBase();
  const redirectUrl = getZerodhaRedirectUrl();
  const isWebDeployment = import.meta.env.PROD && !Capacitor.isNativePlatform();
  const usesHostedBroker = Boolean(brokerApiBase) && !/localhost|127\.0\.0\.1/i.test(brokerApiBase);
  const backendLabel = isWebDeployment || usesHostedBroker ? 'Hosted backend active' : 'Local backend active';
  const redirectLabel = 'Zerodha redirect URL';
  const redirectDisplay = redirectUrl;
  const getHoldingKey = (row) => `${String(row?.exchange || 'NSE').trim().toUpperCase()}:${String(row?.symbol || '').trim().toUpperCase()}`;

  const currentSymbols = useMemo(
    () => new Set(currentStocks.map((stock) => getHoldingKey(stock))),
    [currentStocks],
  );
  const backendUnavailable = /backend unavailable|unable to reach broker backend|timed out/i.test(status?.error || '');

  const loadStatus = async () => {
    setLoading(true);
    try {
      const data = await getZerodhaStatus();
      setStatus(data);
    } catch (error) {
      setStatus({ configured: false, connected: false, unavailable: true, error: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const connect = async () => {
    try {
      const data = await getZerodhaLoginUrl(Capacitor.isNativePlatform() ? 'native' : 'web');
      if (Capacitor.isNativePlatform()) {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url: data.loginUrl });
      } else {
        window.location.assign(data.loginUrl);
      }
    } catch (error) {
      toast.error(error.message);
    }
  };

  const syncHoldings = async () => {
    setSyncing(true);
    try {
      const [holdingsData, positionsData] = await Promise.all([
        getZerodhaHoldings(),
        getZerodhaPositions().catch(() => ({ data: { net: [], day: [] } })),
      ]);

      const rawHoldings = holdingsData?.data || [];
      const rawPositions = (positionsData?.data?.net || []).filter((p) => p.quantity !== 0);

      // Map both holdings and positions
      const mappedHoldings = rawHoldings.map((item) => ({
        ...mapZerodhaHoldingToPortfolio(item),
        raw: item,
      }));
      const mappedPositions = rawPositions.map((item) => ({
        ...mapZerodhaPositionToPortfolio(item),
        raw: item,
      }));

      // Merge by exchange:symbol key
      const mergedMap = new Map();
      mappedHoldings.forEach((m) => {
        mergedMap.set(getHoldingKey(m), m);
      });

      // Add positions - if stock exists in holdings (like T1), we sum the quantities
      mappedPositions.forEach((m) => {
        const key = getHoldingKey(m);
        const existing = mergedMap.get(key);
        if (existing) {
          // Zerodha Holdings API includes T1. Positions(net) includes today's net change.
          // Summing ensures we capture intraday buys/sells on top of existing holdings.
          existing.quantity += m.quantity;
          existing.notes = `${existing.notes} | ${m.notes}`.slice(0, 200);
        } else {
          mergedMap.set(key, m);
        }
      });

      const brokerHoldings = Array.from(mergedMap.values());
      const nextStocks = [...currentStocks];
      let createdCount = 0;
      let updatedCount = 0;
      const diagnostics = [];
      const keyCounts = new Map();

      for (const mapped of brokerHoldings) {
        const item = mapped.raw;
        const mappedKey = getHoldingKey(mapped);
        const existingIndex = nextStocks.findIndex((stock) => getHoldingKey(stock) === mappedKey);
        keyCounts.set(mappedKey, (keyCounts.get(mappedKey) || 0) + 1);

        diagnostics.push({
          key: mappedKey,
          exchange: mapped.exchange || item.exchange || '--',
          symbol: mapped.symbol || item.tradingsymbol || item.symbol || '--',
          quantity: mapped.quantity,
          averagePrice: mapped.buy_price,
          lastPrice: mapped.current_price,
          isin: String(item.isin || '').trim() || '--',
          status: existingIndex !== -1 ? 'update' : 'create',
          queryHint: mappedKey,
        });

        if (existingIndex !== -1) {
          updatedCount += 1;
          const existing = nextStocks[existingIndex];
          nextStocks[existingIndex] = {
            ...existing,
            ...mapped,
            id: existing.id,
            created_date: existing.created_date,
          };
        } else {
          createdCount += 1;
          nextStocks.push(mapped);
        }
      }

      // Perform a bulk replace for efficiency
      await base44.entities.Stock.replace(nextStocks);

      const duplicateDiagnostics = diagnostics.filter((row) => (keyCounts.get(row.key) || 0) > 1);
      const reviewDiagnostics = diagnostics.filter((row) => (
        !row.symbol
        || row.symbol === '--'
        || !Number.isFinite(Number(row.quantity))
        || Number(row.quantity) <= 0
        || !['NSE', 'BSE'].includes(String(row.exchange || '').trim().toUpperCase())
        || (keyCounts.get(row.key) || 0) > 1
      ));

      console.groupCollapsed('[TickerTap] Zerodha holdings sync diagnostics');
      console.info('Counts', {
        rawHoldings: rawHoldings.length,
        rawPositions: rawPositions.length,
        uniqueKeys: mergedMap.size,
        createdCount,
        updatedCount,
      });
      console.table(diagnostics);
      if (duplicateDiagnostics.length) {
        console.warn('[TickerTap] Duplicate Zerodha holding keys detected:');
        console.table(duplicateDiagnostics);
      }
      if (reviewDiagnostics.length) {
        console.warn('[TickerTap] Review these holdings first:');
        console.table(reviewDiagnostics);
      }
      console.groupEnd();

      toast.success(`Zerodha synced. ${createdCount} added, ${updatedCount} updated. ${rawPositions.length} active positions processed.`);
      await onSynced?.();
      await loadStatus();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectZerodha();
      toast.success('Zerodha session disconnected.');
      await loadStatus();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDisconnecting(false);
    }
  };

  const onTestTelegram = async () => {
    try {
      await testTelegramAlert();
      toast.success('Telegram P&L test message sent!');
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <section className="rounded-[32px] border border-white/10 bg-[#0b1624]/90 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-amber-200/80">Broker sync</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">Zerodha import</h2>
          <p className="mt-2 text-sm leading-7 text-slate-400">
            Connect Kite Connect, fetch holdings and positions through the active backend, and merge them into the portfolio.
          </p>
          {Capacitor.isNativePlatform() ? (
            <p className="mt-2 text-sm leading-7 text-cyan-200/80">
              Android login opens Zerodha in the browser and should return to the installed app automatically after approval.
            </p>
          ) : null}
        </div>
        <div className="rounded-2xl border border-emerald-300/15 bg-emerald-300/10 p-3 text-emerald-200">
          <Wallet className="h-5 w-5" />
        </div>
      </div>

      <div className="mt-5 rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
        {loading ? (
          <div className="flex items-center gap-3 text-sm text-slate-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking Zerodha connection status...
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${status?.configured ? 'bg-cyan-400/15 text-cyan-200' : 'bg-rose-400/15 text-rose-200'}`}>
                {backendUnavailable ? 'Backend unavailable' : status?.configured ? 'Configured' : 'Not configured'}
              </span>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${status?.connected ? 'bg-emerald-400/15 text-emerald-200' : 'bg-slate-400/15 text-slate-300'}`}>
                {status?.connected ? 'Connected' : 'Disconnected'}
              </span>
              {status?.profile?.user_name ? (
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-300">
                  {status.profile.user_name} ({status.profile.user_id})
                </span>
              ) : null}
            </div>

            <div className="mt-4 text-sm text-slate-400">
              {backendUnavailable
                ? 'Hosted broker backend is currently unavailable. Restart or redeploy the Render service, then retry Zerodha connect.'
                : status?.connected
                ? `Ready to sync live holdings. Current local portfolio already contains ${currentSymbols.size} symbols.`
                : isWebDeployment || usesHostedBroker
                  ? 'Hosted backend is active. Add Zerodha credentials to the Render environment and then connect your account to fetch live broker data.'
                  : 'Add Zerodha API credentials in your local .env and connect your account to fetch live broker data.'}
            </div>

            {status?.error ? <p className="mt-3 text-sm text-rose-300">{status.error}</p> : null}
          </>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <Button onClick={connect} disabled={loading || backendUnavailable || !status?.configured || status?.connected} className="rounded-2xl bg-amber-300 text-slate-950 hover:bg-amber-200">
          <ShieldCheck className="h-4 w-4" />
          Connect Zerodha
        </Button>
        <Button onClick={syncHoldings} disabled={loading || syncing || !status?.connected} variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Sync Holdings
        </Button>
        <Button onClick={onTestTelegram} disabled={loading || !status?.connected} variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
          <Send className="h-4 w-4" />
          Test Telegram
        </Button>
        <Button onClick={disconnect} disabled={loading || disconnecting || !status?.connected} variant="outline" className="rounded-2xl border-white/10 bg-white/5 text-white hover:bg-white/10">
          <LogOut className="h-4 w-4" />
          Disconnect
        </Button>
      </div>

      <div className="mt-5 rounded-[24px] border border-white/8 bg-[#111c2c] p-4 text-sm text-slate-400">
        {backendLabel}:
        <code className="mx-1 rounded bg-black/20 px-2 py-0.5 text-slate-200">{brokerApiBase || 'https://tickertap-backend-88ts.onrender.com'}</code>
        {' '}with {redirectLabel}
        <code className="mx-1 rounded bg-black/20 px-2 py-0.5 text-slate-200">{redirectDisplay}</code>.
        {!isWebDeployment && !usesHostedBroker ? (
          <>
            {' '}If you are testing locally, run <code className="mx-1 rounded bg-black/20 px-2 py-0.5 text-slate-200">npm run dev:server</code> and set the local env file.
          </>
        ) : null}
      </div>
    </section>
  );
}
