import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as d3 from 'd3';
import { RefreshCw, TrendingUp, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getBrokerApiBase } from '@/lib/brokerClient';

const BENCHMARKS = [
  { id: 'NIFTY 50', label: 'NIFTY 50' },
  { id: 'NIFTY BANK', label: 'BANK NIFTY' },
  { id: 'NIFTY 500', label: 'NIFTY 500' },
];

const TAIL_LENGTHS = [6, 8, 12, 16, 20];

const QUADRANT_COLORS = {
  Leading: { bg: 'rgba(34, 197, 94, 0.1)', text: '#15803d', label: 'Leading' },
  Weakening: { bg: 'rgba(234, 179, 8, 0.08)', text: '#a16207', label: 'Weakening' },
  Lagging: { bg: 'rgba(239, 68, 68, 0.1)', text: '#b91c1c', label: 'Lagging' },
  Improving: { bg: 'rgba(6, 182, 212, 0.1)', text: '#0e7490', label: 'Improving' },
};

export default function SectorRotationSection() {
  const [benchmark, setBenchmark] = useState('NIFTY 50');
  const [tailLength, setTailLength] = useState(8);
  const chartRef = useRef(null);
  const tooltipRef = useRef(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['rrg', benchmark, tailLength],
    queryFn: async () => {
      const apiBase = getBrokerApiBase();
      if (!apiBase) {
        throw new Error('Broker API base is not configured. Set VITE_API_BASE_URL or VITE_HOSTED_API_BASE_URL.');
      }
      const res = await fetch(`${apiBase}/api/rrg?benchmark=${encodeURIComponent(benchmark)}&tail=${tailLength}`);
      if (!res.ok) throw new Error('Failed to fetch RRG data');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!data || !chartRef.current) return;

    const sectors = Object.values(data.sectors);
    if (sectors.length === 0) return;

    renderChart(sectors);
  }, [data]);

  const renderChart = (sectors) => {
    const container = chartRef.current;
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = 500;
    const margin = { top: 40, right: 40, bottom: 50, left: 60 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    d3.select(container).selectAll('svg').remove();

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    const chartG = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Flatten all tail points to find domains
    const allPts = sectors.flatMap(s => s.tail || []);
    if (allPts.length === 0) return;

    const xMin = d3.min(allPts, d => d.rs_ratio);
    const xMax = d3.max(allPts, d => d.rs_ratio);
    const yMin = d3.min(allPts, d => d.rs_momentum);
    const yMax = d3.max(allPts, d => d.rs_momentum);

    const xPad = Math.max((xMax - xMin) * 0.15, 1);
    const yPad = Math.max((yMax - yMin) * 0.15, 1);

    const xScale = d3.scaleLinear()
      .domain([Math.min(xMin - xPad, 98), Math.max(xMax + xPad, 102)])
      .range([0, innerW]);

    const yScale = d3.scaleLinear()
      .domain([Math.min(yMin - yPad, 98), Math.max(yMax + yPad, 102)])
      .range([innerH, 0]);

    const cx = xScale(100);
    const cy = yScale(100);

    // Draw Quadrants
    const quads = [
      { x: cx, y: 0, w: innerW - cx, h: cy, key: 'Leading' },
      { x: 0, y: 0, w: cx, h: cy, key: 'Improving' },
      { x: cx, y: cy, w: innerW - cx, h: innerH - cy, key: 'Weakening' },
      { x: 0, y: cy, w: cx, h: innerH - cy, key: 'Lagging' },
    ];

    quads.forEach(q => {
      if (q.w > 0 && q.h > 0) {
        chartG.append('rect')
          .attr('x', q.x)
          .attr('y', q.y)
          .attr('width', q.w)
          .attr('height', q.h)
          .attr('fill', QUADRANT_COLORS[q.key].bg);

        chartG.append('text')
          .attr('x', q.x + q.w / 2)
          .attr('y', q.y + q.h / 2)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .attr('fill', QUADRANT_COLORS[q.key].text)
          .attr('opacity', 0.2)
          .attr('font-weight', 'bold')
          .attr('font-size', '24px')
          .text(q.key.toUpperCase());
      }
    });

    // Crosshairs
    chartG.append('line')
      .attr('x1', cx).attr('x2', cx).attr('y1', 0).attr('y2', innerH)
      .attr('stroke', '#cbd5e1').attr('stroke-width', 1).attr('stroke-dasharray', '4 4');
    chartG.append('line')
      .attr('x1', 0).attr('x2', innerW).attr('y1', cy).attr('y2', cy)
      .attr('stroke', '#cbd5e1').attr('stroke-width', 1).attr('stroke-dasharray', '4 4');

    // Axes
    const xAxis = d3.axisBottom(xScale).ticks(8).tickFormat(d => d.toFixed(1));
    const yAxis = d3.axisLeft(yScale).ticks(8).tickFormat(d => d.toFixed(1));

    chartG.append('g').attr('transform', `translate(0,${innerH})`).call(xAxis)
      .attr('color', '#94a3b8').style('font-size', '10px');
    chartG.append('g').call(yAxis)
      .attr('color', '#94a3b8').style('font-size', '10px');

    // Labels
    chartG.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 35)
      .attr('text-anchor', 'middle').attr('fill', '#64748b').attr('font-size', '12px').text('Relative Strength (RS-Ratio)');
    chartG.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2).attr('y', -45)
      .attr('text-anchor', 'middle').attr('fill', '#64748b').attr('font-size', '12px').text('Relative Momentum (RS-Momentum)');

    // Line generator
    const lineGen = d3.line()
      .x(d => xScale(d.rs_ratio))
      .y(d => yScale(d.rs_momentum))
      .curve(d3.curveCardinal.tension(0.4));

    // Draw tails and points
    sectors.forEach(sec => {
      const g = chartG.append('g').attr('class', 'sector-group').style('cursor', 'pointer');
      
      if (sec.tail && sec.tail.length > 1) {
        g.append('path')
          .attr('d', lineGen(sec.tail))
          .attr('fill', 'none')
          .attr('stroke', sec.color)
          .attr('stroke-width', 2)
          .attr('opacity', 0.6);
      }

      const current = sec.current;
      if (current) {
        // Trail points
        sec.tail.forEach((pt, i) => {
          const isLast = i === sec.tail.length - 1;
          const progress = sec.tail.length > 1 ? i / (sec.tail.length - 1) : 1;
          const radius = isLast ? 6 : 2 + progress * 2;
          const opacity = isLast ? 1 : 0.2 + progress * 0.4;

          g.append('circle')
            .attr('cx', xScale(pt.rs_ratio))
            .attr('cy', yScale(pt.rs_momentum))
            .attr('r', radius)
            .attr('fill', sec.color)
            .attr('opacity', opacity)
            .on('mouseenter', (event) => {
              const tooltip = tooltipRef.current;
              tooltip.innerHTML = `
                <div class="font-bold text-slate-900">${sec.name}</div>
                <div class="text-xs text-slate-500">${pt.date}</div>
                <div class="mt-1 flex justify-between gap-4 text-xs">
                  <span>Ratio:</span> <b>${pt.rs_ratio.toFixed(2)}</b>
                </div>
                <div class="flex justify-between gap-4 text-xs">
                  <span>Momentum:</span> <b>${pt.rs_momentum.toFixed(2)}</b>
                </div>
                <div class="mt-1 text-xs font-semibold" style="color:${QUADRANT_COLORS[sec.quadrant]?.text || '#64748b'}">
                  ${sec.quadrant}
                </div>
              `;
              tooltip.style.opacity = 1;
              tooltip.style.left = (event.pageX + 10) + 'px';
              tooltip.style.top = (event.pageY + 10) + 'px';
            })
            .on('mousemove', (event) => {
              const tooltip = tooltipRef.current;
              tooltip.style.left = (event.pageX + 10) + 'px';
              tooltip.style.top = (event.pageY + 10) + 'px';
            })
            .on('mouseleave', () => {
              tooltipRef.current.style.opacity = 0;
            });
        });

        // Current Label
        g.append('text')
          .attr('x', xScale(current.rs_ratio) + 10)
          .attr('y', yScale(current.rs_momentum) + 4)
          .attr('fill', '#1e293b')
          .attr('font-size', '10px')
          .attr('font-weight', '600')
          .text(sec.name);
      }
    });
  };

  return (
    <section className="app-panel rounded-[32px] p-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-slate-900">Sector Rotation Map (RRG)</h2>
            <div className="group relative">
              <Info className="h-4 w-4 cursor-help text-slate-400" />
              <div className="invisible absolute left-0 top-6 z-50 w-64 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-xl group-hover:visible">
                Relative Rotation Graphs (RRG) plot symbols vs a benchmark to show relative strength and momentum. 
                <br /><br />
                <b>Leading:</b> Outperforming with positive momentum.<br />
                <b>Weakening:</b> Outperforming but losing momentum.<br />
                <b>Lagging:</b> Underperforming with negative momentum.<br />
                <b>Improving:</b> Underperforming but gaining momentum.
              </div>
            </div>
          </div>
          <p className="mt-1 text-sm text-slate-500">Live NSE sector rotation vs {benchmark} over {tailLength} weeks.</p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex rounded-2xl border border-slate-200 bg-slate-50 p-1">
            {BENCHMARKS.map((b) => (
              <button
                key={b.id}
                onClick={() => setBenchmark(b.id)}
                className={`rounded-xl px-4 py-1.5 text-xs font-medium transition-all ${benchmark === b.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Tail</span>
            <div className="flex rounded-2xl border border-slate-200 bg-slate-50 p-1">
              {TAIL_LENGTHS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTailLength(t)}
                  className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-all ${tailLength === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {t}w
                </button>
              ))}
            </div>
          </div>

          <Button 
            variant="outline" 
            size="icon" 
            onClick={() => refetch()} 
            disabled={isLoading}
            className="rounded-xl border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="relative min-h-[500px] w-full overflow-hidden rounded-[24px] border border-slate-100 bg-white shadow-sm">
        {isLoading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/60 backdrop-blur-sm">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-50">
              <RefreshCw className="h-6 w-6 animate-spin text-orange-500" />
            </div>
            <p className="mt-4 text-sm font-medium text-slate-600">Computing live RRG tails...</p>
            <p className="mt-1 text-xs text-slate-400">Fetching 2 years of history for NSE sectors</p>
          </div>
        )}

        {isError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-rose-50/50">
            <p className="text-sm font-medium text-rose-600">Failed to load rotation data.</p>
            <Button variant="link" onClick={() => refetch()} className="text-rose-500">Try again</Button>
          </div>
        )}

        <div ref={chartRef} className="h-full w-full" />
      </div>

      <div 
        ref={tooltipRef}
        className="pointer-events-none fixed z-[1000] rounded-xl border border-slate-200 bg-white/95 p-3 shadow-2xl backdrop-blur-sm transition-opacity duration-150"
        style={{ opacity: 0, minWidth: '140px' }}
      />

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        {data?.sectors && Object.values(data.sectors).map((sec) => (
          <div key={sec.symbol} className="flex items-center gap-3 rounded-[20px] border border-slate-100 bg-slate-50/50 p-3">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: sec.color }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="truncate text-xs font-bold text-slate-900">{sec.symbol}</span>
                <span className={`text-[10px] font-bold uppercase ${QUADRANT_COLORS[sec.quadrant]?.text.replace('#', 'text-[#') || ''}`} style={{ color: QUADRANT_COLORS[sec.quadrant]?.text }}>
                  {sec.quadrant}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                <span>Ratio: {sec.current?.rs_ratio.toFixed(1)}</span>
                <span>Mom: {sec.current?.rs_momentum.toFixed(1)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
