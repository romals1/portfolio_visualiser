import { useEffect, useState } from 'react'
import Plot from 'react-plotly.js'
import { ComputeResult } from '../types'
import { useTheme } from '../lib/useTheme'

type View = 'total' | 'by_symbol'
type Metric = 'portfolio_value' | 'net_return' | 'rolling_return' | 'breakdown'
type Range = 'All' | 'YTD' | '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y'

interface Props {
  result: ComputeResult
  view: View
  metric: Metric
  range: Range
  rollingWindow: number
}

function rollingAnnReturn(
  netReturn: number[],
  portfolioValue: number[],
  window: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(netReturn.length).fill(null)
  for (let i = window; i < netReturn.length; i++) {
    let logSum = 0
    let valid = true
    for (let j = i - window + 1; j <= i; j++) {
      const prevPV = portfolioValue[j - 1]
      if (!prevPV || prevPV === 0) {
        valid = false
        break
      }
      const diff = netReturn[j] - netReturn[j - 1]
      const mult = Math.max(1 + diff / prevPV, 1e-10)
      logSum += Math.log(mult)
    }
    if (valid) out[i] = Math.exp(logSum * (252 / window)) - 1
  }
  return out
}

function cutoffForRange(range: Range): string | null {
  if (range === 'All') return null
  const today = new Date()
  if (range === 'YTD') return `${today.getFullYear()}-01-01`
  const months: Record<string, number> = { '1M': 1, '3M': 3, '6M': 6 }
  const years: Record<string, number> = { '1Y': 1, '3Y': 3, '5Y': 5 }
  const d = new Date(today)
  if (months[range] !== undefined) d.setMonth(d.getMonth() - months[range])
  else if (years[range] !== undefined) d.setFullYear(d.getFullYear() - years[range])
  return d.toISOString().slice(0, 10)
}

function applyRange<T>(
  dates: string[],
  values: T[],
  cutoff: string | null,
): [string[], T[]] {
  if (!cutoff) return [dates, values]
  const idx = dates.findIndex((d) => d >= cutoff)
  if (idx === -1) return [[], []]
  return [dates.slice(idx), values.slice(idx)]
}

export default function PortfolioChart({ result, view, metric, range, rollingWindow }: Props) {
  const {
    dates,
    portfolio_value: pv,
    net_return: nr,
    capital_return_pure: crPure,
    dividend_return_pure: drPure,
    fx_return: fxRet,
    symbols,
    display_currency,
    benchmarks,
  } = result
  const cutoff = cutoffForRange(range)

  const showRolling = metric === 'rolling_return'
  const showNetReturn = metric === 'net_return'
  const showBreakdown = metric === 'breakdown'
  const bySymbol = view === 'by_symbol'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traces: any[] = []

  if (showRolling) {
    if (bySymbol) {
      for (const [ticker, sym] of Object.entries(symbols)) {
        const rolling = rollingAnnReturn(sym.net_return, sym.value, rollingWindow)
        const [fd, fv] = applyRange(dates, rolling, cutoff)
        traces.push({ x: fd, y: fv, mode: 'lines', name: ticker, hovertemplate: `${ticker} %{x|%Y-%m-%d}<br>%{y:.1%}<extra></extra>` })
      }
    } else {
      const rolling = rollingAnnReturn(nr, pv, rollingWindow)
      const [fd, fv] = applyRange(dates, rolling, cutoff)
      traces.push({ x: fd, y: fv, mode: 'lines', name: 'Portfolio', hovertemplate: `%{x|%Y-%m-%d}<br>%{y:.1%}<extra></extra>` })
    }
  } else if (showBreakdown) {
    // Breakdown decomposes net return into three components that sum to it:
    //   capital_return_pure + dividend_return_pure + fx_return = net_return
    if (bySymbol) {
      for (const [ticker, sym] of Object.entries(symbols)) {
        for (const [suffix, vals] of [
          ['cap', sym.capital_return_pure],
          ['div', sym.div_cashflow_pure],
          ['fx', sym.fx_return],
        ] as [string, number[]][]) {
          if (!vals.some((v) => Math.abs(v) > 0)) continue
          const label = `${ticker} — ${suffix}`
          const [fd, fv] = applyRange(dates, vals, cutoff)
          traces.push({ x: fd, y: fv, mode: 'lines', name: label, hovertemplate: `${label} %{x|%Y-%m-%d}<br>$%{y:,.2f} ${display_currency}<extra></extra>` })
        }
      }
    } else {
      for (const [labelSuffix, vals] of [
        ['Capital gains', crPure],
        ['Dividends', drPure],
        ['FX return', fxRet],
      ] as [string, number[]][]) {
        if (!vals.some((v) => Math.abs(v) > 0)) continue
        const [fd, fv] = applyRange(dates, vals, cutoff)
        traces.push({ x: fd, y: fv, mode: 'lines', name: labelSuffix, hovertemplate: `${labelSuffix} %{x|%Y-%m-%d}<br>$%{y:,.2f} ${display_currency}<extra></extra>` })
      }
    }
  } else if (bySymbol) {
    for (const [ticker, sym] of Object.entries(symbols)) {
      const vals = showNetReturn ? sym.net_return : sym.value
      const [fd, fv] = applyRange(dates, vals, cutoff)
      traces.push({ x: fd, y: fv, mode: 'lines', name: ticker, hovertemplate: `${ticker} %{x|%Y-%m-%d}<br>$%{y:,.2f} ${display_currency}<extra></extra>` })
    }
  } else {
    const vals = showNetReturn ? nr : pv
    const [fd, fv] = applyRange(dates, vals, cutoff)
    traces.push({ x: fd, y: fv, mode: 'lines', name: 'Portfolio', hovertemplate: `%{x|%Y-%m-%d}<br>$%{y:,.2f} ${display_currency}<extra></extra>` })
  }

  // Benchmark overlays (skip in breakdown mode)
  if (!showBreakdown) {
    for (const [bm, bmData] of Object.entries(benchmarks)) {
      if (!bmData.dates.length) continue
      if (showRolling) {
        const rolling = rollingAnnReturn(bmData.net_return, bmData.portfolio_value, rollingWindow)
        const [fd, fv] = applyRange(bmData.dates, rolling, cutoff)
        traces.push({ x: fd, y: fv, mode: 'lines', name: bm, line: { dash: 'dash' }, hovertemplate: `${bm} %{x|%Y-%m-%d}<br>%{y:.1%}<extra></extra>` })
      } else {
        const vals = showNetReturn ? bmData.net_return : bmData.portfolio_value
        const [fd, fv] = applyRange(bmData.dates, vals, cutoff)
        traces.push({ x: fd, y: fv, mode: 'lines', name: bm, line: { dash: 'dash' }, hovertemplate: `${bm} %{x|%Y-%m-%d}<br>$%{y:,.2f} ${display_currency}<extra></extra>` })
      }
    }
  }

  const yTitle = showRolling
    ? 'Annualised return'
    : showBreakdown || showNetReturn
    ? `Return ($ ${display_currency})`
    : `Value ($ ${display_currency})`

  const showLegend =
    bySymbol || showRolling || showBreakdown || Object.keys(benchmarks).length > 0

  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 640 : false,
  )
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const chartColors = isDark
    ? { font: '#e5e7eb', grid: '#1f2937', line: '#374151', zero: '#6b7280' }
    : { font: '#1f2937', grid: '#e5e7eb', line: '#d1d5db', zero: '#9ca3af' }

  const legendLayout = isNarrow
    ? { bgcolor: 'rgba(0,0,0,0)', bordercolor: chartColors.line, orientation: 'h' as const, y: -0.25, x: 0, xanchor: 'left' as const, yanchor: 'top' as const }
    : { bgcolor: 'rgba(0,0,0,0)', bordercolor: chartColors.line }

  const shapes =
    showRolling || showNetReturn || showBreakdown
      ? [{ type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 0, y1: 0, line: { color: chartColors.zero, width: 1, dash: 'dash' } }]
      : []

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
      <Plot
        data={traces}
        layout={{
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { color: chartColors.font, family: 'ui-sans-serif, system-ui, sans-serif' },
          height: 500,
          margin: { t: 40, b: isNarrow && showLegend ? 120 : 40, l: 70, r: 20 },
          showlegend: showLegend,
          legend: legendLayout,
          xaxis: { gridcolor: chartColors.grid, linecolor: chartColors.line, tickcolor: chartColors.line },
          yaxis: {
            title: { text: yTitle },
            gridcolor: chartColors.grid,
            linecolor: chartColors.line,
            tickcolor: chartColors.line,
            tickformat: showRolling ? '.0%' : undefined,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          shapes: shapes as any,
        }}
        config={{ responsive: true, displayModeBar: false }}
        style={{ width: '100%' }}
        useResizeHandler
      />
    </div>
  )
}
