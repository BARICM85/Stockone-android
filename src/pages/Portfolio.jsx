import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Download, FileSpreadsheet, Loader2, Plus, Search, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { base44 } from '@/api/base44Client';
import AddStockDialog from '@/components/portfolio/AddStockDialog';
import ImportDialog from '@/components/portfolio/ImportDialog';
import StockTable from '@/components/portfolio/StockTable';
import { derivePortfolioAnalytics, formatCompactCurrency, formatCurrency, formatPercent } from '@/lib/portfolioAnalytics';
import { buildPortfolioAdvancedMetrics } from '@/lib/advancedAnalytics';
import { getLiveMarketQuote, getLiveMarketQuotes } from '@/lib/brokerClient';

function exportPortfolioForImport(stocks) {
  if (stocks.length === 0) {
    toast.error('No stocks to export.');
    return;
  }

  // Exact columns ImportDialog expects: BROKER, Stock, Buy Date, Buy Price, Qty, Buy Value
  const data = stocks.map((stock) => ({
    BROKER: stock.broker || 'MANUAL',
    Stock: stock.symbol,
    'Buy Date': stock.buy_date || '',
    'Buy Price': stock.buy_price,
    Qty: stock.quantity,
    'Buy Value': stock.buy_value || (stock.quantity * stock.buy_price),
    Exchange: stock.exchange || 'NSE',
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Import_Format');
  XLSX.writeFile(workbook, 'portfolio-import-format.xlsx');
  toast.success('Exported in import format.');
}

function exportPortfolioDetailed(stocks) {
  if (stocks.length === 0) {
    toast.error('No stocks to export.');
    return;
  }

  const data = stocks.map((stock) => ({
    Symbol: stock.symbol,
    Name: stock.name,
    Exchange: stock.exchange || 'NSE',
    Sector: stock.sector || '--',
    Quantity: stock.quantity,
    'Buy Price': stock.buy_price,
    'Current Price': stock.current_price,
    'Invested Value': (stock.quantity * stock.buy_price).toFixed(2),
    'Current Value': (stock.quantity * stock.current_price).toFixed(2),
    'P&L': ((stock.current_price - stock.buy_price) * stock.quantity).toFixed(2),
    'P&L %': stock.buy_price ? (((stock.current_price - stock.buy_price) / stock.buy_price) * 100).toFixed(2) + '%' : '0%',
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Portfolio_PNL');
  XLSX.writeFile(workbook, 'portfolio-pnl-report.xlsx');
  toast.success('Exported detailed P&L report.');
}

export default function Portfolio() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteId, setDeleteId] = useState(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [refreshingId, setRefreshingId] = useState(null);
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();
  const { data: stocks = [], isLoading } = useQuery({
    queryKey: ['stocks'],
    queryFn: () => base44.entities.Stock.list('-created_date'),
  });

  const analytics = useMemo(
    () => derivePortfolioAnalytics(stocks, { includeTimeline: false, includeScenarios: false }),
    [stocks],
  );
  const advancedMetrics = useMemo(() => buildPortfolioAdvancedMetrics(analytics), [analytics]);

  useEffect(() => {
    const broker = searchParams.get('broker');
    const status = searchParams.get('status');
    const error = searchParams.get('error');
    if (broker !== 'zerodha' || !status) return;

    if (status === 'connected') toast.success('Zerodha connected successfully.');
    if (status === 'error') toast.error(error || 'Zerodha connection failed.');

    const next = new URLSearchParams(searchParams);
    next.delete('broker');
    next.delete('status');
    next.delete('error');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const filteredStocks = useMemo(() => {
    const needle = search.toLowerCase();
    return analytics.holdings.filter((stock) => {
      const haystack = `${stock.symbol} ${stock.name} ${stock.sector}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [analytics.holdings, search]);

  const refreshAll = async () => {
    setRefreshingId('all');
    try {
      const { results, failures } = await getLiveMarketQuotes(
        stocks.map((stock) => ({
          symbol: stock.symbol,
          exchange: stock.exchange || 'NSE',
        })),
        { concurrency: 5, timeoutMs: 4000 },
      );

      const updates = new Map();
      stocks.forEach((stock) => {
        const quote = results.get(`${String(stock.exchange || 'NSE').trim().toUpperCase()}:${String(stock.symbol || '').trim().toUpperCase()}`);
        if (quote?.price) updates.set(stock.id, Number(quote.price));
      });

      if (updates.size > 0) {
        const nextStocks = stocks.map((stock) => (
          updates.has(stock.id)
            ? { ...stock, current_price: updates.get(stock.id) }
            : stock
        ));
        await base44.entities.Stock.replace(nextStocks);
      }

      await queryClient.invalidateQueries({ queryKey: ['stocks'] });

      if (updates.size === 0) toast.error('Live price fetch failed for all holdings.');
      else if (failures.length === 0) toast.success('Live market prices fetched for all holdings.');
      else toast.success(`Live prices updated for ${updates.size} holdings with ${failures.length} fallback${failures.length === 1 ? '' : 's'}.`);
    } finally {
      setRefreshingId(null);
    }
  };

  const refreshOne = async (stock) => {
    setRefreshingId(stock.id);
    try {
      const quote = await getLiveMarketQuote(stock.symbol, {
        exchange: stock.exchange || 'NSE',
        timeoutMs: 4000,
      });
      await base44.entities.Stock.update(stock.id, { current_price: quote.price || stock.current_price });
      toast.success(`${stock.symbol} live price updated.`);
    } catch {
      toast.error(`${stock.symbol} live quote was unavailable.`);
    }
    await queryClient.invalidateQueries({ queryKey: ['stocks'] });
    setRefreshingId(null);
  };

  const deleteHolding = async () => {
    if (!deleteId) return;
    await base44.entities.Stock.delete(deleteId);
    await queryClient.invalidateQueries({ queryKey: ['stocks'] });
    setDeleteId(null);
    toast.success('Holding removed.');
  };

  const clearPortfolio = async () => {
    await base44.entities.Stock.replace([]);
    await queryClient.invalidateQueries({ queryKey: ['stocks'] });
    setClearOpen(false);
    toast.success('Portfolio cleared.');
  };

  if (isLoading) {
    return (
      <div className="flex h-80 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-amber-300" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="app-hero rounded-[36px] p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-orange-500/80">Portfolio operations</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900">Manage holdings with a cleaner, easier-to-read workflow</h1>
            <p className="mt-3 max-w-2xl app-subtle-text">
              Add, import, refresh, and clean holdings from one place. This screen is tuned to feel more like an operations desk and less like a raw data form.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="rounded-2xl border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                  <Download />
                  Export
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 border-white/10 bg-[#0c1422] p-2 text-white">
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    onClick={() => exportPortfolioForImport(stocks)}
                    className="justify-start gap-2 rounded-xl text-left hover:bg-white/5 hover:text-amber-200"
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    <span>Import Format</span>
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => exportPortfolioDetailed(stocks)}
                    className="justify-start gap-2 rounded-xl text-left hover:bg-white/5 hover:text-cyan-200"
                  >
                    <Download className="h-4 w-4" />
                    <span>Detailed P&L</span>
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <Button variant="outline" onClick={() => setImportOpen(true)} className="rounded-2xl border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
              <FileSpreadsheet />
              Import
            </Button>
            <Button variant="outline" onClick={() => setClearOpen(true)} disabled={stocks.length === 0} className="rounded-2xl border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:text-slate-400">
              <Trash2 />
              Clear Portfolio
            </Button>
            <Button onClick={() => setAddOpen(true)} className="rounded-2xl bg-orange-500 text-white hover:bg-orange-600">
              <Plus />
              Add Holding
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-3">
          {[
            'Import first if you already have an Excel portfolio.',
            'Fetch Live Prices after imports or broker sync.',
            'Use Clear Portfolio only when you want a full reset.',
          ].map((item) => (
            <div key={item} className="rounded-[22px] border border-slate-200 bg-white/80 px-4 py-3 text-sm text-slate-700">
              {item}
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Invested Capital', value: formatCurrency(analytics.totals.totalInvested), note: `${analytics.holdings.length} holdings` },
          { label: 'Current Value', value: formatCurrency(analytics.totals.totalValue), note: formatPercent(analytics.totals.totalPnLPercent) },
          { label: 'Net Gain / Loss', value: `${analytics.totals.totalPnL >= 0 ? '+' : '-'}${formatCompactCurrency(Math.abs(analytics.totals.totalPnL))}`, note: 'Absolute portfolio move' },
          { label: 'Largest Holding', value: analytics.holdings[0] ? `${analytics.holdings[0].symbol} ${analytics.holdings[0].allocation.toFixed(1)}%` : '--', note: 'Use this to monitor concentration' },
        ].map((card) => (
          <div key={card.label} className="app-panel rounded-[28px] p-5">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{card.label}</p>
            <p className="mt-3 text-2xl font-semibold text-slate-900">{card.value}</p>
            <p className="mt-2 text-sm text-slate-500">{card.note}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[
          {
            label: 'Absolute Return',
            value: formatPercent(advancedMetrics.absoluteReturnPercent || 0),
            note: 'Current portfolio gain from cost basis',
          },
          {
            label: 'CAGR',
            value: Number.isFinite(advancedMetrics.cagrPercent) ? formatPercent(advancedMetrics.cagrPercent) : 'Unavailable',
            note: advancedMetrics.startDate ? 'Annualized since your earliest buy' : 'Add buy dates for annualized return',
          },
          {
            label: 'XIRR',
            value: Number.isFinite(advancedMetrics.xirrPercent) ? formatPercent(advancedMetrics.xirrPercent) : 'Unavailable',
            note: 'Handles staggered purchases',
          },
          {
            label: 'Weighted Beta',
            value: advancedMetrics.weightedBeta.toFixed(2),
            note: 'Portfolio sensitivity vs market',
          },
          {
            label: 'Treynor Ratio',
            value: Number.isFinite(advancedMetrics.treynorRatio) ? advancedMetrics.treynorRatio.toFixed(2) : 'Unavailable',
            note: 'Return earned per unit of beta',
          },
          {
            label: 'Sector Concentration',
            value: advancedMetrics.topSectorWeight ? `${advancedMetrics.topSectorWeight.toFixed(1)}%` : '--',
            note: 'Largest sector share of portfolio value',
          },
        ].map((card) => (
          <div key={card.label} className="app-panel rounded-[28px] p-5">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">{card.label}</p>
            <p className="mt-3 text-2xl font-semibold text-slate-900">{card.value}</p>
            <p className="mt-2 text-sm text-slate-500">{card.note}</p>
          </div>
        ))}
      </section>

      <section className="app-panel rounded-[32px] p-6">
        <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full max-w-xl">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by symbol, company, or sector"
              className="h-12 rounded-2xl border-slate-200 bg-white pl-11 text-slate-900 placeholder:text-slate-400"
            />
          </div>
          <Button onClick={refreshAll} disabled={refreshingId === 'all'} variant="outline" className="rounded-2xl border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
            {refreshingId === 'all' ? <Loader2 className="animate-spin" /> : null}
            <Zap />
            Fetch Live Prices
          </Button>
        </div>

        <StockTable stocks={filteredStocks} onDelete={setDeleteId} onRefreshPrice={refreshOne} refreshingId={refreshingId} />
      </section>

      <section className="app-panel rounded-[32px] p-6">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              title: 'Best for beginners',
              text: 'Use Add Holding for one or two stocks so you can understand the data fields before importing a large file.',
            },
            {
              title: 'Best for speed',
              text: 'Use Import when you already have your portfolio in Excel, then run Fetch Live Prices once to normalize current values.',
            },
            {
              title: 'Best for cleanup',
              text: 'Search by symbol, company, or sector to trim duplicate entries before syncing or exporting.',
            },
          ].map((item) => (
            <div key={item.title} className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-5">
              <p className="font-medium text-slate-900">{item.title}</p>
              <p className="mt-2 text-sm text-slate-500">{item.text}</p>
            </div>
          ))}
        </div>
      </section>
      <AddStockDialog open={addOpen} onOpenChange={setAddOpen} onStockAdded={() => queryClient.invalidateQueries({ queryKey: ['stocks'] })} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImportComplete={() => queryClient.invalidateQueries({ queryKey: ['stocks'] })} />

      <AlertDialog open={Boolean(deleteId)} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent className="border-white/10 bg-[#0c1422] text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this holding?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              This deletes the position from your browser-stored portfolio. It can be re-imported later if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-white/5 text-white hover:bg-white/10">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteHolding} className="bg-rose-400 text-slate-950 hover:bg-rose-300">Delete Holding</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent className="border-white/10 bg-[#0c1422] text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the full portfolio?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              This removes every holding from local storage so you can start fresh with your own stocks or broker sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-white/5 text-white hover:bg-white/10">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={clearPortfolio} className="bg-rose-400 text-slate-950 hover:bg-rose-300">Clear Portfolio</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
