import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Bell, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import BrokerSyncPanel from '@/components/integrations/BrokerSyncPanel';
import PortfolioStats from '@/components/dashboard/PortfolioStats';
import CustomTestingSection from '@/components/dashboard/CustomTestingSection';
import BacktestSection from '@/components/dashboard/BacktestSection';
import AllocationChart from '@/components/dashboard/AllocationChart';
import PortfolioHistoryChart from '@/components/dashboard/PortfolioHistoryChart';
import PnLChart from '@/components/dashboard/PnLChart';
import { derivePortfolioAnalytics, deriveWatchlistAnalytics, formatCurrency, formatPercent, getMarketLaggards, getMarketLeaders } from '@/lib/portfolioAnalytics';

function Panel({ title, subtitle, action, children }) {
  return (
    <section className="app-panel rounded-[32px] p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function Dashboard() {
  const [groupBy, setGroupBy] = useState('stock');
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const { data: stocks = [] } = useQuery({
    queryKey: ['stocks'],
    queryFn: () => base44.entities.Stock.list('-created_date'),
  });
  const { data: watchlist = [] } = useQuery({
    queryKey: ['watchlist'],
    queryFn: () => base44.entities.Watchlist.list('-created_date'),
  });

  const analytics = derivePortfolioAnalytics(stocks);
  const watchlistInsights = deriveWatchlistAnalytics(watchlist, analytics.holdings);
  const leaders = getMarketLeaders();
  const laggards = getMarketLaggards();

  const refreshAll = async () => {
    setRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ['stocks'] });
    await queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    setRefreshing(false);
  };

  return (
    <div className="space-y-6">
      <section className="app-hero rounded-[36px] p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs uppercase tracking-[0.28em] text-orange-500/80">StockOne analyzer</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900">A calmer command center for holdings, risk, and trade prep</h1>
            <p className="mt-3 app-subtle-text">
              The dashboard is now tuned for faster reading: clearer priority cards, less visual noise, and a steadier theme for long portfolio review sessions.
            </p>
          </div>
          <Button onClick={refreshAll} disabled={refreshing} className="rounded-2xl bg-orange-500 text-white hover:bg-orange-600">
            <RefreshCw className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing' : 'Refresh Snapshot'}
          </Button>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-3">
          {[
            'Start on Dashboard for portfolio pulse and concentration.',
            'Use Portfolio for imports, clean-up, and live price refresh.',
            'Use Risk Lab before any major rebalance or hedge.',
          ].map((item) => (
            <div key={item} className="rounded-[22px] border border-slate-200 bg-white/80 px-4 py-3 text-sm text-slate-700">
              {item}
            </div>
          ))}
        </div>
      </section>

      <BrokerSyncPanel
        currentStocks={stocks}
        onSynced={async () => {
          await queryClient.invalidateQueries({ queryKey: ['stocks'] });
        }}
      />

      <PortfolioStats analytics={analytics} />

      <CustomTestingSection stocks={stocks} />

      <BacktestSection stocks={stocks} />

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
        <Panel title="Portfolio Through Time" subtitle="Track invested capital, current value, and profit across your imported lots.">
          <PortfolioHistoryChart analytics={analytics} />
        </Panel>

        <Panel title="P&L Summary" subtitle="Absolute and percentage performance based on current holdings.">
          <div className="grid gap-3 md:grid-cols-2">
            {[
              { label: 'Net P&L', value: `${analytics.totals.totalPnL >= 0 ? '+' : '-'}${formatCurrency(Math.abs(analytics.totals.totalPnL))}`, detail: formatPercent(analytics.totals.totalPnLPercent) },
              { label: 'Best Position', value: analytics.topWinner ? analytics.topWinner.symbol : '--', detail: analytics.topWinner ? formatPercent(analytics.topWinner.pnlPercent) : 'Import holdings to calculate' },
              { label: 'Worst Position', value: analytics.topLoser ? analytics.topLoser.symbol : '--', detail: analytics.topLoser ? formatPercent(analytics.topLoser.pnlPercent) : 'Import holdings to calculate' },
              { label: 'Import History Points', value: String(analytics.historySeries.length), detail: 'Timeline entries from imported lots' },
            ].map((card) => (
              <div key={card.label} className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{card.label}</p>
                <p className="mt-3 text-2xl font-semibold text-slate-900">{card.value}</p>
                <p className="mt-2 text-sm text-slate-500">{card.detail}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
        <Panel
          title="Allocation Map"
          subtitle="Understand how portfolio weight is distributed."
          action={(
            <div className="flex rounded-full border border-white/10 bg-white/[0.04] p-1 text-sm">
              {['stock', 'sector'].map((mode) => (
                <button
                  key={mode}
                  onClick={() => setGroupBy(mode)}
                  className={`rounded-full px-4 py-1.5 capitalize ${groupBy === mode ? 'bg-orange-500 text-white' : 'text-slate-600'}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          )}
        >
          <AllocationChart analytics={analytics} groupBy={groupBy} />
        </Panel>

        <Panel title="P&L Heatmap" subtitle="Quickly spot contributors and drags across the imported portfolio.">
          <PnLChart analytics={analytics} />
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Panel title="Watchlist Triggers" subtitle="Targets close to your entry zone.">
          <div className="space-y-3">
            {watchlistInsights.slice(0, 4).map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-4">
                <div>
                  <p className="font-medium text-slate-900">{item.symbol}</p>
                  <p className="text-sm text-slate-500">{item.name}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-slate-600">Current {formatCurrency(item.current_price)}</p>
                  <p className="text-sm text-orange-600">Target {formatCurrency(item.target_price)}</p>
                  <p className="text-xs text-slate-500">{item.status}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Portfolio Pulse" subtitle="The highest-signal stats at a glance.">
          <div className="grid gap-3 md:grid-cols-2">
            {[
              { label: 'Diversification', value: `${analytics.totals.diversificationScore}/100`, detail: 'Higher is better' },
              { label: 'Weighted Beta', value: analytics.totals.weightedBeta.toFixed(2), detail: 'Volatility vs market' },
              { label: 'Largest Position', value: analytics.holdings[0] ? `${analytics.holdings[0].symbol} ${analytics.holdings[0].allocation.toFixed(1)}%` : '--', detail: 'Concentration driver' },
              { label: 'Income Run Rate', value: formatCurrency(analytics.totals.monthlyIncome * 12), detail: 'Annualized dividend estimate' },
            ].map((card) => (
              <div key={card.label} className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{card.label}</p>
                <p className="mt-3 text-2xl font-semibold text-slate-900">{card.value}</p>
                <p className="mt-2 text-sm text-slate-500">{card.detail}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Top Movers" subtitle="Best performing names in the local market snapshot.">
          <div className="space-y-3">
            {leaders.map((stock) => (
              <div key={stock.symbol} className="flex items-center justify-between rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-4">
                <div>
                  <p className="font-medium text-slate-900">{stock.symbol}</p>
                  <p className="text-sm text-slate-500">{stock.name}</p>
                </div>
                <div className="flex items-center gap-2 text-emerald-600">
                  <TrendingUp className="h-4 w-4" />
                  <span>{formatPercent(stock.day_change_percent)}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Pressure List" subtitle="Names cooling off in the same snapshot universe.">
          <div className="space-y-3">
            {laggards.map((stock) => (
              <div key={stock.symbol} className="flex items-center justify-between rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-4">
                <div>
                  <p className="font-medium text-slate-900">{stock.symbol}</p>
                  <p className="text-sm text-slate-500">{stock.name}</p>
                </div>
                <div className="flex items-center gap-2 text-rose-600">
                  <TrendingDown className="h-4 w-4" />
                  <span>{formatPercent(stock.day_change_percent)}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="How To Use This App" subtitle="Simple guidance to make the screens easier to learn.">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              title: 'Daily check',
              text: 'Start with Dashboard, then review net P&L, largest position, and near-target watchlist names.',
            },
            {
              title: 'Weekly review',
              text: 'Move to Risk Lab for sector concentration, beta, and rebalance ideas before making portfolio changes.',
            },
            {
              title: 'Trading workflow',
              text: 'Review broker sync and risk state before placing any order so execution stays tied to the portfolio.',
            },
          ].map((item) => (
            <div key={item.title} className="rounded-[24px] border border-white/8 bg-white/[0.03] p-5">
              <p className="font-medium text-white">{item.title}</p>
              <p className="mt-2 text-sm text-slate-400">{item.text}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="What to do next" subtitle="Simple operating checklist for this portfolio.">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              icon: Bell,
              title: 'Review near-target watchlist names',
              text: watchlistInsights.some((item) => item.status === 'Buy zone' || item.status === 'Near target')
                ? 'At least one watchlist name is in or near your preferred buy zone.'
                : 'No watchlist names are near target right now, so patience is okay.',
            },
            {
              icon: ArrowUpRight,
              title: 'Trim concentration if needed',
              text: analytics.rebalanceIdeas[0]?.reason || 'Portfolio concentration looks manageable at the moment.',
            },
            {
              icon: TrendingUp,
              title: 'Protect your winners',
              text: analytics.topWinner
                ? `${analytics.topWinner.symbol} leads performance at ${formatPercent(analytics.topWinner.pnlPercent)}. Decide whether to let it run or rebalance.`
                : 'No winner identified yet because the portfolio is empty.',
            },
          ].map((item) => (
            <div key={item.title} className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-5">
              <item.icon className="h-5 w-5 text-orange-500" />
              <p className="mt-4 font-medium text-slate-900">{item.title}</p>
              <p className="mt-2 text-sm text-slate-500">{item.text}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
