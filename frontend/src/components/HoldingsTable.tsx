import { useMemo, useState } from 'react'
import { ComputeResult } from '../types'

interface Props {
  result: ComputeResult | null
}

interface HoldingRow {
  ticker: string
  portfolio: string
  marketValue: number
  netReturn: number
  percentReturn: number
  pastWeekAbsolute: number
  pastWeekPercent: number
  currency: string
}

type SortKey =
  | 'ticker'
  | 'portfolio'
  | 'marketValue'
  | 'netReturn'
  | 'percentReturn'
  | 'pastWeekAbsolute'
type SortDir = 'asc' | 'desc'

interface Column {
  key: SortKey
  label: string
  align?: 'left' | 'right'
}

const COLUMNS: Column[] = [
  { key: 'ticker', label: 'Symbol' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'marketValue', label: 'Market Value', align: 'right' },
  { key: 'netReturn', label: 'Net Return', align: 'right' },
  { key: 'percentReturn', label: 'Return %', align: 'right' },
  { key: 'pastWeekAbsolute', label: 'Past Week', align: 'right' },
]

function formatCurrency(value: number, currency: string): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(2)}%`
}

function colorClass(v: number): string {
  return v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
}

// Same day-weighted return calculation used in PortfolioStats:
// buys are start-of-day deployments, sales/dividends are end-of-day
// withdrawals, so cashflows don't count as returns.
function computeDayWeightedReturn(value: number[], netReturn: number[]): number {
  let multiplier = 1
  let any = false
  for (let t = 1; t < value.length; t++) {
    const cumCfPrev = netReturn[t - 1] - value[t - 1]
    const cumCfCurr = netReturn[t] - value[t]
    const cashflow = cumCfCurr - cumCfPrev
    const deployed = Math.max(-cashflow, 0)
    const withdrawn = Math.max(cashflow, 0)
    const denom = value[t - 1] + deployed
    if (denom <= 0) continue
    const numer = value[t] + withdrawn
    const dayMult = numer / denom
    if (!Number.isFinite(dayMult) || dayMult < 0) continue
    multiplier *= dayMult
    any = true
  }
  return any ? multiplier - 1 : 0
}

function buildRows(result: ComputeResult): HoldingRow[] {
  const rows: HoldingRow[] = []
  for (const [portfolioName, port] of Object.entries(result.portfolios)) {
    const lastIdx = port.dates.length - 1
    if (lastIdx < 0) continue
    for (const [ticker, sym] of Object.entries(port.symbols)) {
      const marketValue = sym.value[lastIdx] ?? 0
      if (!(marketValue > 0)) continue
      const netReturn = sym.net_return[lastIdx] ?? 0
      const percentReturn = computeDayWeightedReturn(sym.value, sym.net_return)

      const weekAgoIdx = Math.max(0, lastIdx - 5)
      let pastWeekAbsolute = 0
      let pastWeekPercent = 0
      if (weekAgoIdx < lastIdx) {
        pastWeekAbsolute = netReturn - (sym.net_return[weekAgoIdx] ?? 0)
        const weekAgoValue = sym.value[weekAgoIdx] ?? 0
        pastWeekPercent = weekAgoValue !== 0 ? pastWeekAbsolute / weekAgoValue : 0
      }

      rows.push({
        ticker,
        portfolio: portfolioName,
        marketValue,
        netReturn,
        percentReturn,
        pastWeekAbsolute,
        pastWeekPercent,
        currency: port.display_currency,
      })
    }
  }
  return rows
}

export default function HoldingsTable({ result }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('marketValue')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [filters, setFilters] = useState<Partial<Record<SortKey, string>>>({})

  const rows = useMemo(() => (result ? buildRows(result) : []), [result])

  const totalValue = rows.reduce((s, r) => s + r.marketValue, 0)
  const displayCurrency = rows[0]?.currency ?? 'USD'

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(key === 'ticker' || key === 'portfolio' ? 'asc' : 'desc')
    }
  }

  const setFilter = (key: SortKey, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }))
  }

  const filtered = rows.filter((row) =>
    COLUMNS.every(({ key }) => {
      const q = (filters[key] ?? '').trim().toLowerCase()
      if (!q) return true
      const cell =
        key === 'marketValue' || key === 'netReturn'
          ? String(row[key].toFixed(2))
          : key === 'percentReturn'
            ? String((row[key] * 100).toFixed(2))
            : key === 'pastWeekAbsolute'
              ? `${row.pastWeekAbsolute.toFixed(2)} ${(row.pastWeekPercent * 100).toFixed(2)}`
              : String(row[key])
      return cell.toLowerCase().includes(q)
    }),
  )

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    let cmp: number
    if (typeof av === 'number' && typeof bv === 'number') {
      cmp = av - bv
    } else {
      cmp = String(av).localeCompare(String(bv))
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  if (!result || rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-8 text-center text-sm text-gray-600 dark:text-gray-400">
        No current holdings to display.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Holdings ({rows.length} {rows.length === 1 ? 'symbol' : 'symbols'})
        </h2>
        <span className="text-sm text-gray-600 dark:text-gray-400">
          Total: <span className="text-gray-800 dark:text-gray-200 font-medium">{formatCurrency(totalValue, displayCurrency)}</span>
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
            <tr>
              {COLUMNS.map(({ key, label, align }) => {
                const arrow = sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
                return (
                  <th
                    key={key}
                    onClick={() => toggleSort(key)}
                    className={
                      'px-3 py-2 font-medium whitespace-nowrap cursor-pointer select-none hover:text-gray-900 dark:hover:text-white ' +
                      (align === 'right' ? 'text-right' : 'text-left')
                    }
                  >
                    {label}
                    {arrow}
                  </th>
                )
              })}
            </tr>
            <tr>
              {COLUMNS.map(({ key }) => (
                <th key={key} className="px-2 pb-2">
                  <input
                    value={filters[key] ?? ''}
                    onChange={(e) => setFilter(key, e.target.value)}
                    placeholder="filter..."
                    className="w-full bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 rounded px-1 py-0.5 text-xs font-normal focus:outline-none"
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
            {sorted.map((row, idx) => (
              <tr
                key={`${row.portfolio}::${row.ticker}`}
                className={(idx % 2 === 0 ? 'bg-gray-50 dark:bg-gray-950' : 'bg-white dark:bg-gray-900') + ' hover:bg-gray-200 dark:hover:bg-gray-800'}
              >
                <td className="px-3 py-2 text-gray-800 dark:text-gray-200 font-medium">{row.ticker}</td>
                <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{row.portfolio}</td>
                <td className="px-3 py-2 text-right text-gray-800 dark:text-gray-200 tabular-nums">
                  {formatCurrency(row.marketValue, row.currency)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${colorClass(row.netReturn)}`}>
                  {formatCurrency(row.netReturn, row.currency)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${colorClass(row.percentReturn)}`}>
                  {formatPercent(row.percentReturn)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${colorClass(row.pastWeekAbsolute)}`}>
                  {formatCurrency(row.pastWeekAbsolute, row.currency)}{' '}
                  <span className="text-xs">({formatPercent(row.pastWeekPercent)})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
