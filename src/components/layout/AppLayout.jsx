import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, Briefcase, Eye, LogOut, RefreshCw, Shield, TrendingUp, UserCircle2 } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { toast } from 'sonner';
import GoogleSignInButton from '@/components/auth/GoogleSignInButton';
import { useAuth } from '@/lib/AuthContext';
import { getBrokerApiBase } from '@/lib/brokerClient';
import { formatCurrency } from '@/lib/portfolioAnalytics';
import { base44 } from '@/api/base44Client';

const NAV_ITEMS = [
  { path: '/Dashboard', label: 'Dashboard', icon: BarChart3 },
  { path: '/Portfolio', label: 'Portfolio', icon: Briefcase },
  { path: '/RiskAnalysis', label: 'Risk Lab', icon: Shield },
  { path: '/Watchlist', label: 'Watchlist', icon: Eye },
];

function NavLink({ item, active, onClick }) {
  return (
    <Link
      to={item.path}
      onClick={onClick}
      className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition-all ${
        active
          ? 'bg-orange-500 text-white shadow-[0_12px_30px_rgba(249,115,22,0.22)]'
          : 'text-slate-600 hover:bg-orange-50 hover:text-slate-900'
      }`}
    >
      <item.icon className="h-4 w-4" />
      <span>{item.label}</span>
    </Link>
  );
}

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isAuthenticated, googleConfigured, logout } = useAuth();
  const queryClient = useQueryClient();
  const [syncStatus, setSyncStatus] = useState(() => base44.sync.getStatus());
  const [manualSyncing, setManualSyncing] = useState(false);
  const apiBaseUrl = getBrokerApiBase();
  const { data: indexPayload } = useQuery({
    queryKey: ['header-indices'],
    refetchInterval: 60000,
    queryFn: async () => {
      const response = await fetch(`${apiBaseUrl}/api/market/indices`);
      if (!response.ok) throw new Error('Unable to load index quotes.');
      return response.json();
    },
  });
  const indexItems = indexPayload?.items || [];
  const hasDelayedIndices = indexItems.some((item) => item.delayed);

  useEffect(() => base44.sync.subscribe(setSyncStatus), []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;

    const handleNativeUrl = ({ url }) => {
      if (!url) return;
      let incoming;
      try {
        incoming = new URL(url);
      } catch {
        return;
      }

      if (incoming.protocol !== 'tickertap:' || incoming.hostname !== 'zerodha') {
        return;
      }

      const next = new URLSearchParams();
      next.set('broker', 'zerodha');
      next.set('status', incoming.searchParams.get('status') || 'error');
      const error = incoming.searchParams.get('error');
      if (error) next.set('error', error);
      navigate(`/Portfolio?${next.toString()}`, { replace: true });
    };

    let removeListener = () => {};
    CapacitorApp.addListener('appUrlOpen', handleNativeUrl).then((listener) => {
      removeListener = () => listener.remove();
    });
    CapacitorApp.getLaunchUrl().then((launchData) => {
      if (launchData?.url) handleNativeUrl({ url: launchData.url });
    });

    return () => removeListener();
  }, [navigate]);

  useEffect(() => {
    const handleSyncEvent = (event) => {
      const keys = event.detail?.keys || [];
      if (keys.includes('stocks')) {
        queryClient.invalidateQueries({ queryKey: ['stocks'] });
      }
      if (keys.includes('watchlist')) {
        queryClient.invalidateQueries({ queryKey: ['watchlist'] });
      }
    };

    window.addEventListener('portfolio-data-sync', handleSyncEvent);
    return () => window.removeEventListener('portfolio-data-sync', handleSyncEvent);
  }, [queryClient]);

  useEffect(() => {
    void base44.sync.refreshStatus();
    queryClient.invalidateQueries({ queryKey: ['stocks'] });
    queryClient.invalidateQueries({ queryKey: ['watchlist'] });
  }, [queryClient, user?.id]);

  const handleManualSync = async () => {
    setManualSyncing(true);
    try {
      const nextStatus = await base44.sync.syncNow();
      setSyncStatus(nextStatus);
      queryClient.invalidateQueries({ queryKey: ['stocks'] });
      queryClient.invalidateQueries({ queryKey: ['watchlist'] });
      toast.success(nextStatus.mode === 'active' ? 'Cloud sync completed.' : nextStatus.label);
    } catch (error) {
      toast.error(error.message || 'Cloud sync failed.');
    } finally {
      setManualSyncing(false);
    }
  };

  const syncBadgeClassName = syncStatus.mode === 'active'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : syncStatus.mode === 'syncing'
      ? 'border-cyan-200 bg-cyan-50 text-cyan-700'
      : syncStatus.mode === 'unavailable'
        ? 'border-rose-200 bg-rose-50 text-rose-700'
        : 'border-slate-200 bg-slate-50 text-slate-600';

  const accountCard = isAuthenticated ? (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
      {user?.picture ? (
        <img src={user.picture} alt={user.name} className="h-9 w-9 rounded-full object-cover" />
      ) : (
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-orange-100 text-orange-600">
          <UserCircle2 className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">{user?.name || user?.email}</p>
        <p className="truncate text-xs text-slate-500">{user?.email}</p>
      </div>
      <button
        onClick={logout}
        className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-100"
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </button>
    </div>
  ) : googleConfigured ? (
    <div className="w-full max-w-[320px]">
      <GoogleSignInButton />
    </div>
  ) : null;

  return (
    <div className="app-shell">
      <div className="app-backdrop pointer-events-none fixed inset-0" />

      <header className="fixed inset-x-0 top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1680px] items-center justify-between px-4 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-orange-500 p-2 text-white">
              <TrendingUp className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">StockOne Portfolio</p>
              <p className="text-xs text-slate-500">Portfolio analyzer</p>
            </div>
          </div>

          <nav className="hidden flex-1 items-center justify-center gap-2 px-8 lg:flex">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.path} item={item} active={location.pathname === item.path} />
            ))}
          </nav>

          <div className="hidden items-center gap-3 lg:flex">
            <div className={`rounded-2xl border px-3 py-2 text-xs font-medium ${syncBadgeClassName}`}>
              {syncStatus.label}
            </div>
            {isAuthenticated ? (
              <button
                onClick={handleManualSync}
                disabled={manualSyncing || syncStatus.mode === 'local'}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${manualSyncing ? 'animate-spin' : ''}`} />
                Sync now
              </button>
            ) : null}
            {accountCard}
          </div>
        </div>

        <div className="border-t border-slate-200/70 lg:hidden">
          <div className="mx-auto max-w-[1680px] px-4 py-2 lg:px-8">
            <div className={`mb-2 inline-flex rounded-2xl border px-3 py-2 text-xs font-medium ${syncBadgeClassName}`}>
              {syncStatus.label}
            </div>
            {isAuthenticated ? (
              <button
                onClick={handleManualSync}
                disabled={manualSyncing || syncStatus.mode === 'local'}
                className="mb-2 ml-2 inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${manualSyncing ? 'animate-spin' : ''}`} />
                Sync now
              </button>
            ) : null}
            {accountCard ? <div className="mb-2">{accountCard}</div> : null}
            <div className="flex gap-2 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.path} item={item} active={location.pathname === item.path} />
            ))}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200/70">
          <div className="mx-auto max-w-[1680px] px-4 py-1.5 lg:px-8">
            {hasDelayedIndices ? (
              <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-orange-500/70">Last close shown for unavailable/holiday indices</p>
            ) : null}
            <div className="flex gap-2 overflow-x-auto whitespace-nowrap pb-1 [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-track]:bg-transparent">
              {indexItems.length ? indexItems.map((item) => {
                const positive = Number(item.changePercent || 0) >= 0;
                return (
                  <div key={item.key} className="flex min-w-fit items-center gap-2 rounded-[18px] border border-slate-200 bg-white px-2.5 py-1.5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{item.label}</p>
                      <p className="mt-0.5 text-[15px] font-semibold leading-none text-slate-900">{formatCurrency(item.price, item.currency || 'INR').replace('.00', '')}</p>
                    </div>
                    <div className={`rounded-full px-2 py-1 text-[11px] font-semibold leading-none ${positive ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                      {positive ? '+' : ''}{Number(item.changePercent || 0).toFixed(2)}%
                    </div>
                    {item.delayed ? (
                      <div className="rounded-full bg-orange-100 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-orange-700">LC</div>
                    ) : null}
                  </div>
                );
              }) : (
                <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
                  Loading NSE indices...
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      <div className="relative mx-auto max-w-[1680px] px-3 pb-10 pt-[18.5rem] sm:px-4 sm:pt-[17rem] lg:px-8 lg:pt-48">
        <main className="relative z-10 min-w-0 pt-2 lg:pt-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
