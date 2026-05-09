import { ComputeResult } from '../types'

interface Props {
  result: ComputeResult
}

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

function getColorClass(value: number): string {
  return value >= 0 ? 'text-emerald-400' : 'text-rose-400'
}

interface Stats {
  totalReturnAbsolute: number
  totalReturnPercent: number
  annualizedReturn: number
  pastWeek: { absolute: number; percent: number }
  currency: string
}

// Day-weighted total return: cumulative product of daily multipliers.
// Buys are treated as start-of-day capital deployments, sales/dividends
// as end-of-day withdrawals — so cashflows don't count as returns.
function computeTotalReturnPercent(
  portfolioValue: number[],
  netReturn: number[],
): number {
  let multiplier = 1
  let any = false
  for (let t = 1; t < portfolioValue.length; t++) {
    const cumCfPrev = netReturn[t - 1] - portfolioValue[t - 1]
    const cumCfCurr = netReturn[t] - portfolioValue[t]
    const cashflow = cumCfCurr - cumCfPrev
    const deployed = Math.max(-cashflow, 0)
    const withdrawn = Math.max(cashflow, 0)
    const denom = portfolioValue[t - 1] + deployed
    if (denom <= 0) continue
    const numer = portfolioValue[t] + withdrawn
    const dayMult = numer / denom
    if (!Number.isFinite(dayMult) || dayMult < 0) continue
    multiplier *= dayMult
    any = true
  }
  return any ? multiplier - 1 : 0
}

function computeStats(
  dates: string[],
  portfolioValue: number[],
  netReturn: number[],
  currency: string,
): Stats {
  const firstNonZeroIdx = portfolioValue.findIndex((v) => v > 0)
  if (firstNonZeroIdx === -1 || dates.length < 2) {
    return {
      totalReturnAbsolute: 0,
      totalReturnPercent: 0,
      annualizedReturn: 0,
      pastWeek: { absolute: 0, percent: 0 },
      currency,
    }
  }

  const lastIdx = dates.length - 1
  const lastNetReturn = netReturn[lastIdx]
  const firstNetReturn = netReturn[firstNonZeroIdx]

  const totalReturnAbsolute = lastNetReturn - firstNetReturn
  const totalReturnPercent = computeTotalReturnPercent(portfolioValue, netReturn)

  const nTradingDays = lastIdx - firstNonZeroIdx + 1
  let annualizedReturn = totalReturnPercent
  if (nTradingDays >= 21 && 1 + totalReturnPercent > 0 && Number.isFinite(totalReturnPercent)) {
    annualizedReturn = Math.pow(1 + totalReturnPercent, 252 / nTradingDays) - 1
  }

  let pastWeek = { absolute: 0, percent: 0 }
  const weekAgoIdx = Math.max(0, lastIdx - 5)
  if (weekAgoIdx < lastIdx) {
    const weekAgoNetReturn = netReturn[weekAgoIdx]
    const weekAgoPortfolioValue = portfolioValue[weekAgoIdx]
    pastWeek.absolute = lastNetReturn - weekAgoNetReturn
    pastWeek.percent = weekAgoPortfolioValue !== 0 ? pastWeek.absolute / weekAgoPortfolioValue : 0
  }

  return {
    totalReturnAbsolute,
    totalReturnPercent,
    annualizedReturn,
    pastWeek,
    currency,
  }
}

function StatCard({
  title,
  absoluteValue,
  percentValue,
  currency,
  showAbsolute = true,
}: {
  title: string
  absoluteValue: number
  percentValue: number
  currency: string
  showAbsolute?: boolean
}) {
  const primary = showAbsolute ? absoluteValue : percentValue
  const primaryFormatted = showAbsolute
    ? formatCurrency(absoluteValue, currency)
    : formatPercent(percentValue)

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{title}</p>
      <p className={`text-3xl font-semibold ${getColorClass(primary)} mb-1`}>
        {primaryFormatted}
      </p>
      {showAbsolute && (
        <p className={`text-sm ${getColorClass(percentValue)}`}>
          {formatPercent(percentValue)}
        </p>
      )}
    </div>
  )
}

function StatsRow({ stats, currency }: { stats: Stats; currency: string }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <StatCard
        title="Total return"
        absoluteValue={stats.totalReturnAbsolute}
        percentValue={stats.totalReturnPercent}
        currency={currency}
      />
      <StatCard
        title="Annualized return"
        absoluteValue={0}
        percentValue={stats.annualizedReturn}
        currency={currency}
        showAbsolute={false}
      />
      <StatCard
        title="Return past week"
        absoluteValue={stats.pastWeek.absolute}
        percentValue={stats.pastWeek.percent}
        currency={currency}
      />
    </div>
  )
}

export default function PortfolioStats({ result }: Props) {
  const portfolioNames = Object.keys(result.portfolios)

  if (portfolioNames.length === 1) {
    const portName = portfolioNames[0]
    const { dates, portfolio_value: pv, net_return: nr, display_currency } = result.portfolios[portName]

    if (dates.length < 2 || !pv.some((v) => v > 0)) {
      return (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <p className="text-gray-400 text-center py-8">Not enough data to compute statistics</p>
        </div>
      )
    }

    const stats = computeStats(dates, pv, nr, display_currency)

    return (
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <StatsRow stats={stats} currency={display_currency} />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {portfolioNames.map((portName) => {
        const { dates, portfolio_value: pv, net_return: nr, display_currency } = result.portfolios[portName]

        if (dates.length < 2 || !pv.some((v) => v > 0)) {
          return (
            <div key={portName} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="text-sm font-medium text-gray-300 mb-4">{portName}</h3>
              <p className="text-gray-400 text-center py-4">Not enough data to compute statistics</p>
            </div>
          )
        }

        const stats = computeStats(dates, pv, nr, display_currency)

        return (
          <div key={portName} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-sm font-medium text-gray-300 mb-4">{portName}</h3>
            <StatsRow stats={stats} currency={display_currency} />
          </div>
        )
      })}
    </div>
  )
}
