import { useState } from 'react'
import { ComputeResult } from '../types'
import PortfolioChart from './PortfolioChart'
import Spinner from './Spinner'

type View = 'total' | 'by_symbol'
type Metric = 'portfolio_value' | 'net_return' | 'rolling_performance' | 'rolling_return' | 'cumulative_performance' | 'breakdown'
type Range = 'All' | 'YTD' | '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y'

interface Props {
  computeResult: ComputeResult | null
  isComputing: boolean
  benchmarkTickers: string[]
  onBenchmarkChange: (tickers: string[]) => void
  onClearCache: () => void
}

function RadioGroup<T extends string>({
  label, options, value, onChange
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`px-3 py-1 text-sm rounded-lg transition-colors ${
              value === o.value
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-700'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function ChartArea({ computeResult, isComputing, benchmarkTickers, onBenchmarkChange, onClearCache }: Props) {
  const [view, setView] = useState<View>('total')
  const [metric, setMetric] = useState<Metric>('portfolio_value')
  const [range, setRange] = useState<Range>('All')
  const [rollingWindow, setRollingWindow] = useState(60)
  const [benchmarkInput, setBenchmarkInput] = useState('')

  const handleBenchmarkChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target.value
    setBenchmarkInput(input)
    const tickers = input
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
    onBenchmarkChange(tickers)
  }

  const rangeOptions: { value: Range; label: string }[] = [
    { value: 'All', label: 'All' },
    { value: 'YTD', label: 'YTD' },
    { value: '1M', label: '1M' },
    { value: '3M', label: '3M' },
    { value: '6M', label: '6M' },
    { value: '1Y', label: '1Y' },
    { value: '3Y', label: '3Y' },
    { value: '5Y', label: '5Y' },
  ]

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 space-y-5">
        <h2 className="text-lg font-medium">Chart controls</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <RadioGroup
            label="View"
            options={[
              { value: 'total', label: 'Total portfolio' },
              { value: 'by_symbol', label: 'By symbol' },
            ]}
            value={view}
            onChange={setView}
          />
          <RadioGroup
            label="Metric"
            options={[
              { value: 'portfolio_value', label: 'Portfolio value' },
              { value: 'net_return', label: 'Net return' },
              { value: 'rolling_performance', label: 'Rolling performance' },
              { value: 'rolling_return', label: 'Rolling return' },
              { value: 'cumulative_performance', label: 'Cumulative performance' },
              { value: 'breakdown', label: 'Return breakdown' },
            ]}
            value={metric}
            onChange={setMetric}
          />
        </div>

        <RadioGroup label="Range" options={rangeOptions} value={range} onChange={setRange} />

        {(metric === 'rolling_performance' || metric === 'rolling_return') && (
          <div className="space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-wide">
              Rolling window: {rollingWindow} trading days
            </p>
            <input
              type="range"
              min={10}
              max={252}
              step={5}
              value={rollingWindow}
              onChange={(e) => setRollingWindow(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>
        )}

        <div className="space-y-1">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Benchmarks</p>
          <input
            value={benchmarkInput}
            onChange={handleBenchmarkChange}
            placeholder="Yahoo Finance tickers, comma-separated — e.g. ^AXJO, ^GSPC"
            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
          />
        </div>

        {isComputing && (
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <Spinner size={14} />
            <span>Fetching prices and computing portfolio…</span>
          </div>
        )}

        {computeResult && computeResult.failed_tickers.length > 0 && (
          <button
            onClick={() => { onClearCache() }}
            className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-white px-4 py-2 rounded-lg text-sm"
          >
            Retry fetching prices
          </button>
        )}
      </div>

      {computeResult && (
        <PortfolioChart
          result={computeResult}
          view={view}
          metric={metric}
          range={range}
          rollingWindow={rollingWindow}
        />
      )}
    </div>
  )
}
