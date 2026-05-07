import { ComputeResult } from '../types'

interface Props {
  result: ComputeResult
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(2)}%`
}

function getColorClass(value: number): string {
  return value >= 0 ? 'text-emerald-400' : 'text-rose-400'
}

interface PortfolioStats {
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
): PortfolioStats {
  // Find first non-zero portfolio value
  const firstNonZeroIdx = portfolioValue.findIndex((v) => v > 0)
  if (firstNonZeroIdx === -1 || dates.length === 0) {
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
  const costBasisAtFirst = portfolioValue[firstNonZeroIdx] - firstNetReturn

  // Total return (absolute $ and %)
  const totalReturnAbsolute = lastNetReturn - firstNetReturn
  const totalReturnPercent = costBasisAtFirst !== 0 ? totalReturnAbsolute / Math.abs(costBasisAtFirst) : 0

  // Annualized return: (1 + total_return)^(252 / n_trading_days) - 1
  const nTradingDays = lastIdx - firstNonZeroIdx + 1
  const annualizedReturn =
    nTradingDays > 1 ? Math.pow(1 + totalReturnPercent, 252 / nTradingDays) - 1 : totalReturnPercent

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
}: {
  title: string
  primaryValue: number
  secondaryValue: number
  secondaryValuePercent: boolean
}) {
  const primaryColor = getColorClass(primaryValue)
  const secondaryColor = getColorClass(secondaryValue)

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{title}</p>
      <p className={`text-3xl font-semibold ${primaryColor} mb-1`}>
        {secondaryValuePercent ? formatPercent(primaryValue) : formatCurrency(primaryValue, 'USD')}
      </p>
      <p className={`text-sm ${secondaryColor}`}>
        {secondaryValuePercent
          ? formatPercent(secondaryValue)
          : formatCurrency(secondaryValue, 'USD')}
      </p>
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

    return (
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="Total return"
            primaryValue={stats.totalReturnPercent}
            secondaryValue={stats.totalReturnAbsolute}
            secondaryValuePercent={false}
          />
          <StatCard
            title="Annualized return"
            primaryValue={stats.annualizedReturn}
            secondaryValue={0}
            secondaryValuePercent={true}
          />
          <StatCard
            title="Return since last day"
            primaryValue={stats.sinceLastDay.percent}
            secondaryValue={stats.sinceLastDay.absolute}
            secondaryValuePercent={false}
          />
          <StatCard
            title="Return past week"
            primaryValue={stats.pastWeek.percent}
            secondaryValue={stats.pastWeek.absolute}
            secondaryValuePercent={false}
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

        return (
          <div key={portName} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-sm font-medium text-gray-300 mb-4">{portName}</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                title="Total return"
                primaryValue={stats.totalReturnPercent}
                secondaryValue={stats.totalReturnAbsolute}
                secondaryValuePercent={false}
              />
              <StatCard
                title="Annualized return"
                primaryValue={stats.annualizedReturn}
                secondaryValue={0}
                secondaryValuePercent={true}
              />
              <StatCard
                title="Return since last day"
                primaryValue={stats.sinceLastDay.percent}
                secondaryValue={stats.sinceLastDay.absolute}
                secondaryValuePercent={false}
              />
              <StatCard
                title="Return past week"
                primaryValue={stats.pastWeek.percent}
                secondaryValue={stats.pastWeek.absolute}
                secondaryValuePercent={false}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
