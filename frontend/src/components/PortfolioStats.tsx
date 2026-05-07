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
  sinceLastDay: { absolute: number; percent: number }
  pastWeek: { absolute: number; percent: number }
  currency: string
}

function computeStats(
  dates: string[],
  portfolioValue: number[],
  netReturn: number[],
  currency: string,
): Stats {
  // Find first non-zero portfolio value
  const firstNonZeroIdx = portfolioValue.findIndex((v) => v > 0)
  if (firstNonZeroIdx === -1 || dates.length < 2) {
    return {
      totalReturnAbsolute: 0,
      totalReturnPercent: 0,
      annualizedReturn: 0,
      sinceLastDay: { absolute: 0, percent: 0 },
      pastWeek: { absolute: 0, percent: 0 },
      currency,
    }
  }

  const lastIdx = dates.length - 1
  const lastNetReturn = netReturn[lastIdx]
  const firstNetReturn = netReturn[firstNonZeroIdx]

  // Peak invested capital = max over time of cumulative cashflows deployed
  // cost_basis_t = portfolio_value_t - net_return_t (already true in data)
  const investedSeries = portfolioValue.map((p, i) => p - netReturn[i])
  const peakInvested = Math.max(...investedSeries.slice(firstNonZeroIdx))

  // Total return (absolute $ and %)
  // This is a money-weighted approximation, not a true TWRR/IRR
  const totalReturnAbsolute = lastNetReturn - firstNetReturn
  const totalReturnPercent = peakInvested > 0 ? totalReturnAbsolute / peakInvested : 0

  // Annualized return: (1 + total_return)^(252 / n_trading_days) - 1
  // Only annualize when we have at least 21 trading days; otherwise show raw return
  const nTradingDays = lastIdx - firstNonZeroIdx + 1
  let annualizedReturn = totalReturnPercent
  if (nTradingDays >= 21 && 1 + totalReturnPercent > 0 && Number.isFinite(totalReturnPercent)) {
    annualizedReturn = Math.pow(1 + totalReturnPercent, 252 / nTradingDays) - 1
  }

  // Return since last day (absolute + %)
  let sinceLastDay = { absolute: 0, percent: 0 }
  if (lastIdx > 0) {
    const prevNetReturn = netReturn[lastIdx - 1]
    const prevPortfolioValue = portfolioValue[lastIdx - 1]
    sinceLastDay.absolute = lastNetReturn - prevNetReturn
    sinceLastDay.percent = prevPortfolioValue !== 0 ? sinceLastDay.absolute / prevPortfolioValue : 0
  }

  // Return over past week (5 trading days)
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
    sinceLastDay,
    pastWeek,
    currency,
  }
}

function StatCard({
  title,
  primaryValue,
  secondaryValue,
  secondaryValuePercent,
  currency,
}: {
  title: string
  primaryValue: number
  secondaryValue: number
  secondaryValuePercent: boolean
  currency: string
}) {
  const primaryColor = getColorClass(primaryValue)
  const secondaryColor = getColorClass(secondaryValue)

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{title}</p>
      <p className={`text-3xl font-semibold ${primaryColor} mb-1`}>
        {secondaryValuePercent ? formatPercent(primaryValue) : formatCurrency(primaryValue, currency)}
      </p>
      {!secondaryValuePercent && (
        <p className={`text-sm ${secondaryColor}`}>
          {formatCurrency(secondaryValue, currency)}
        </p>
      )}
    </div>
  )
}

export default function PortfolioStats({ result }: Props) {
  const portfolioNames = Object.keys(result.portfolios)

  // If single portfolio, show one row of stats; if multiple, show one row per portfolio
  if (portfolioNames.length === 1) {
    const portName = portfolioNames[0]
    const { dates, portfolio_value: pv, net_return: nr, display_currency } = result.portfolios[portName]

    const stats = computeStats(dates, pv, nr, display_currency)

    // Show placeholder if insufficient data
    if (dates.length < 2 || !pv.some((v) => v > 0)) {
      return (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <p className="text-gray-400 text-center py-8">Not enough data to compute statistics</p>
        </div>
      )
    }

    return (
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="Total return"
            primaryValue={stats.totalReturnPercent}
            secondaryValue={stats.totalReturnAbsolute}
            secondaryValuePercent={false}
            currency={display_currency}
          />
          <StatCard
            title="Annualized return"
            primaryValue={stats.annualizedReturn}
            secondaryValue={0}
            secondaryValuePercent={true}
            currency={display_currency}
          />
          <StatCard
            title="Return since last day"
            primaryValue={stats.sinceLastDay.percent}
            secondaryValue={stats.sinceLastDay.absolute}
            secondaryValuePercent={false}
            currency={display_currency}
          />
          <StatCard
            title="Return past week"
            primaryValue={stats.pastWeek.percent}
            secondaryValue={stats.pastWeek.absolute}
            secondaryValuePercent={false}
            currency={display_currency}
          />
        </div>
      </div>
    )
  }

  // Multiple portfolios: show one row per portfolio
  return (
    <div className="space-y-4">
      {portfolioNames.map((portName) => {
        const { dates, portfolio_value: pv, net_return: nr, display_currency } = result.portfolios[portName]
        const stats = computeStats(dates, pv, nr, display_currency)

        // Show placeholder if insufficient data
        if (dates.length < 2 || !pv.some((v) => v > 0)) {
          return (
            <div key={portName} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="text-sm font-medium text-gray-300 mb-4">{portName}</h3>
              <p className="text-gray-400 text-center py-4">Not enough data to compute statistics</p>
            </div>
          )
        }

        return (
          <div key={portName} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-sm font-medium text-gray-300 mb-4">{portName}</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                title="Total return"
                primaryValue={stats.totalReturnPercent}
                secondaryValue={stats.totalReturnAbsolute}
                secondaryValuePercent={false}
                currency={display_currency}
              />
              <StatCard
                title="Annualized return"
                primaryValue={stats.annualizedReturn}
                secondaryValue={0}
                secondaryValuePercent={true}
                currency={display_currency}
              />
              <StatCard
                title="Return since last day"
                primaryValue={stats.sinceLastDay.percent}
                secondaryValue={stats.sinceLastDay.absolute}
                secondaryValuePercent={false}
                currency={display_currency}
              />
              <StatCard
                title="Return past week"
                primaryValue={stats.pastWeek.percent}
                secondaryValue={stats.pastWeek.absolute}
                secondaryValuePercent={false}
                currency={display_currency}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
