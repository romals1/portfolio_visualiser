import { Transaction, ComputeResult, PortfolioData, SymbolData } from '../types'
import api from '../api/client'

interface TransactionWithFields extends Transaction {
  portfolio: string
  currency: string
  net_amount: number
}

interface PriceData {
  dates: string[]
  values: number[]
}

interface PricesResponse {
  prices: Record<string, PriceData>
  failed: string[]
}

function parseDate(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00Z')
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function forwardFillPrices(
  prices: number[],
  dates: string[],
  targetDates: string[]
): number[] {
  const priceMap = new Map(dates.map((d, i) => [d, prices[i]]))
  const result: number[] = []
  let lastValue = NaN

  for (const targetDate of targetDates) {
    if (priceMap.has(targetDate)) {
      lastValue = priceMap.get(targetDate)!
    }
    result.push(lastValue)
  }

  return result
}

function alignToAxis(
  events: { date: string; value: number }[],
  axis: string[]
): number[] {
  const result = new Array(axis.length).fill(0)
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date))
  let i = 0
  for (const ev of sorted) {
    while (i < axis.length && axis[i] < ev.date) i++
    if (i >= axis.length) {
      // event after last bar — drop with warning
      console.warn(`Transaction on ${ev.date} is after last price bar; dropping cashflow`)
      break
    }
    result[i] += ev.value
  }
  return result
}

function cumsum(xs: number[]): number[] {
  const out = new Array(xs.length).fill(0)
  let s = 0
  for (let i = 0; i < xs.length; i++) {
    s += xs[i]
    out[i] = s
  }
  return out
}

function sumSeries(parts: number[][]): number[] {
  if (parts.length === 0) return []
  if (parts.length === 1) return parts[0]

  const result = parts[0].map((_, i) => {
    return parts.reduce((sum, part) => sum + (part[i] || 0), 0)
  })
  return result
}

function sumDataFrames(parts: Record<string, number[]>[]): Record<string, number[]> {
  if (parts.length === 0) return {}
  if (parts.length === 1) return parts[0]

  const allTickers = new Set<string>()
  parts.forEach(df => Object.keys(df).forEach(t => allTickers.add(t)))

  const result: Record<string, number[]> = {}
  for (const ticker of allTickers) {
    const length = parts[0][Object.keys(parts[0])[0]].length
    result[ticker] = Array(length).fill(0)

    for (const df of parts) {
      if (ticker in df) {
        result[ticker] = result[ticker].map((v, i) => v + (df[ticker][i] || 0))
      }
    }
  }

  return result
}

export async function computePortfolio(
  transactions: Transaction[],
  benchmarkTickers: string[] = []
): Promise<ComputeResult> {
  if (transactions.length === 0) {
    return {
      portfolios: {},
      benchmarks: {},
      failed_tickers: [],
    }
  }

  const txns: TransactionWithFields[] = transactions.map(t => ({
    ...t,
    portfolio: t.portfolio || 'manual',
    currency: t.exchange === 'ASX' ? 'AUD' : 'USD',
    net_amount:
      t.action === 'BUY'
        ? -(t.quantity * t.price + (t.fees || 0))
        : t.quantity * t.price - (t.fees || 0),
  }))

  const portfolioGroups: Record<
    string,
    {
      portfolio_value: number[]
      net_return: number[]
      capital_return: number[]
      dividend_return: number[]
      symbol_values: Record<string, number[]>
      symbol_net_returns: Record<string, number[]>
      symbol_capital_returns: Record<string, number[]>
      symbol_div_cashflows: Record<string, number[]>
      display_currency: string
      dates: string[]
    }
  > = {}

  let fetchFailures: string[] = []

  const portfolioMap = new Map<string, { portfolio: string; txns: TransactionWithFields[] }>()
  for (const txn of txns) {
    const key = txn.portfolio
    if (!portfolioMap.has(key)) {
      portfolioMap.set(key, { portfolio: key, txns: [] })
    }
    portfolioMap.get(key)!.txns.push(txn)
  }

  // Collect all ticker/exchange pairs needed across all portfolios
  const allTickersToFetch = new Set<string>()
  const tickersByExchange: Record<string, Set<string>> = {}
  let needsAUD = false

  for (const { txns: portfolioTxns } of portfolioMap.values()) {
    const currencyMap = new Map<string, TransactionWithFields[]>()
    for (const txn of portfolioTxns) {
      const key = txn.currency
      if (!currencyMap.has(key)) {
        currencyMap.set(key, [])
      }
      currencyMap.get(key)!.push(txn)
    }

    for (const [currency, currencyTxns] of currencyMap) {
      const tradeRows = currencyTxns.filter(t => ['BUY', 'SELL'].includes(t.action))
      if (tradeRows.length === 0) continue

      const exchange = tradeRows[0].exchange
      for (const txn of tradeRows) {
        allTickersToFetch.add(`${exchange}:${txn.ticker}`)
        if (!tickersByExchange[exchange]) {
          tickersByExchange[exchange] = new Set()
        }
        tickersByExchange[exchange].add(txn.ticker)
      }
      if (currency === 'AUD') {
        needsAUD = true
      }
    }
  }

  if (needsAUD) {
    allTickersToFetch.add('US:AUDUSD=X')
    if (!tickersByExchange['US']) {
      tickersByExchange['US'] = new Set()
    }
    tickersByExchange['US'].add('AUDUSD=X')
  }

  // Calculate min/max transaction dates
  let minTxnDate = formatDate(new Date())
  let maxTxnDate = formatDate(new Date())
  if (txns.length > 0) {
    minTxnDate = txns.reduce((min, t) => t.date < min ? t.date : min, txns[0].date)
    maxTxnDate = txns.reduce((max, t) => t.date > max ? t.date : max, txns[0].date)
  }

  const startDate = new Date(minTxnDate + 'T00:00:00Z')
  const endDate = new Date()
  endDate.setUTCDate(endDate.getUTCDate() + 1)

  const startStr = formatDate(startDate)
  const endStr = formatDate(endDate)

  // Single batched price fetch for all tickers
  let allPricesData: Record<string, PriceData> = {}
  let allFailedTickers: string[] = []
  if (allTickersToFetch.size > 0) {
    try {
      const ticketList = Array.from(allTickersToFetch).map(key => {
        const [exchange, ticker] = key.split(':')
        return { ticker, exchange }
      })
      const resp = await api.post<PricesResponse>('/api/prices', {
        tickers: ticketList,
        start: startStr,
        end: endStr,
      })
      allPricesData = resp.data.prices
      allFailedTickers = resp.data.failed || []
    } catch (err) {
      allFailedTickers = Array.from(allTickersToFetch)
    }
  }

  for (const [portfolioName, { txns: portfolioTxns }] of portfolioMap) {
    const pvParts: number[][] = []
    const nrParts: number[][] = []
    const crParts: number[][] = []
    const drParts: number[][] = []
    const svParts: Record<string, number[]>[] = []
    const snrParts: Record<string, number[]>[] = []
    const scrParts: Record<string, number[]>[] = []
    const sdcParts: Record<string, number[]>[] = []
    let dispCurrency = 'USD'
    let allSortedDates: string[] = []

    const currencyMap = new Map<string, TransactionWithFields[]>()
    for (const txn of portfolioTxns) {
      const key = txn.currency
      if (!currencyMap.has(key)) {
        currencyMap.set(key, [])
      }
      currencyMap.get(key)!.push(txn)
    }

    for (const [currency, currencyTxns] of currencyMap) {
      const tradeRows = currencyTxns.filter(t => ['BUY', 'SELL'].includes(t.action))
      if (tradeRows.length === 0) continue

      const exchange = tradeRows[0].exchange
      const tickers = Array.from(new Set(tradeRows.map(t => t.ticker)))

      // Use pre-fetched prices
      let pricesData: Record<string, PriceData> = {}
      for (const ticker of tickers) {
        if (ticker in allPricesData) {
          pricesData[ticker] = allPricesData[ticker]
        }
      }

      const missingTickers = tickers.filter(t => !(t in pricesData))
      if (missingTickers.length > 0) {
        fetchFailures.push(...missingTickers.map(t => `${portfolioName} (${currency}): ${t}`))
        continue
      }

      if (Object.keys(pricesData).length === 0) {
        fetchFailures.push(`${portfolioName} (${currency}): no price data`)
        continue
      }

      const allDates = new Set<string>()
      for (const ticker in pricesData) {
        pricesData[ticker].dates.forEach(d => allDates.add(d))
      }
      const sortedDates = Array.from(allDates).sort()

      const prices: Record<string, number[]> = {}
      for (const ticker of tickers) {
        const data = pricesData[ticker]
        prices[ticker] = forwardFillPrices(data.values, data.dates, sortedDates)
      }

      // Align signed quantities to price dates using alignment function
      const positions: Record<string, number[]> = {}
      for (const ticker of tickers) {
        const qtyEvents = tradeRows
          .filter(t => t.ticker === ticker)
          .map(t => ({
            date: t.date,
            value: t.action === 'BUY' ? t.quantity : -t.quantity,
          }))
        const aligned = alignToAxis(qtyEvents, sortedDates)
        positions[ticker] = cumsum(aligned)
      }

      const symbolValues: Record<string, number[]> = {}
      for (const ticker of tickers) {
        symbolValues[ticker] = positions[ticker].map((pos, i) => pos * prices[ticker][i])
      }

      const portfolioValue = symbolValues[tickers[0]].map((_, i) => {
        return tickers.reduce((sum, t) => sum + (symbolValues[t][i] || 0), 0)
      })

      // Align all (BUY/SELL/DIV) cashflows to price dates
      const symbolCashflows: Record<string, number[]> = {}
      for (const ticker of tickers) {
        const cfEvents = currencyTxns
          .filter(t => t.ticker === ticker && ['BUY', 'SELL', 'DIV'].includes(t.action))
          .map(t => ({
            date: t.date,
            value: t.net_amount,
          }))
        const aligned = alignToAxis(cfEvents, sortedDates)
        symbolCashflows[ticker] = cumsum(aligned)
      }

      const symbolNetReturns: Record<string, number[]> = {}
      for (const ticker of tickers) {
        symbolNetReturns[ticker] = symbolValues[ticker].map((v, i) => v + (symbolCashflows[ticker][i] || 0))
      }

      const totalCashflows = sortedDates.map((_, i) => tickers.reduce((sum, t) => sum + (symbolCashflows[t][i] || 0), 0))
      const netReturn = portfolioValue.map((pv, i) => pv + totalCashflows[i])

      // Align DIV-only cashflows to price dates
      const symbolDivCashflows: Record<string, number[]> = {}
      for (const ticker of tickers) {
        const divEvents = currencyTxns
          .filter(t => t.ticker === ticker && t.action === 'DIV')
          .map(t => ({
            date: t.date,
            value: t.net_amount,
          }))
        const aligned = alignToAxis(divEvents, sortedDates)
        symbolDivCashflows[ticker] = cumsum(aligned)
      }

      const symbolCapitalReturns: Record<string, number[]> = {}
      for (const ticker of tickers) {
        symbolCapitalReturns[ticker] = symbolNetReturns[ticker].map((nr, i) => nr - (symbolDivCashflows[ticker][i] || 0))
      }

      const totalDivCashflows = sortedDates.map((_, i) => tickers.reduce((sum, t) => sum + (symbolDivCashflows[t][i] || 0), 0))
      const capitalReturn = netReturn.map((nr, i) => nr - totalDivCashflows[i])

      let pvToAdd = portfolioValue
      let nrToAdd = netReturn
      let crToAdd = capitalReturn
      let drToAdd = totalDivCashflows
      let svToAdd = symbolValues
      let snrToAdd = symbolNetReturns
      let scrToAdd = symbolCapitalReturns
      let sdcToAdd = symbolDivCashflows

      if (currency === 'AUD' && 'AUDUSD=X' in pricesData) {
        const fxData = pricesData['AUDUSD=X']
        let fxRate = forwardFillPrices(fxData.values, fxData.dates, sortedDates)

        // Back-fill leading NaNs to prevent NaN propagation
        let firstValidIndex = -1
        for (let i = 0; i < fxRate.length; i++) {
          if (!isNaN(fxRate[i])) {
            firstValidIndex = i
            break
          }
        }
        if (firstValidIndex > 0) {
          const firstValidValue = fxRate[firstValidIndex]
          for (let i = 0; i < firstValidIndex; i++) {
            fxRate[i] = firstValidValue
          }
        }

        pvToAdd = portfolioValue.map((pv, i) => pv * fxRate[i])
        nrToAdd = netReturn.map((nr, i) => nr * fxRate[i])
        crToAdd = capitalReturn.map((cr, i) => cr * fxRate[i])
        drToAdd = totalDivCashflows.map((dr, i) => dr * fxRate[i])

        svToAdd = {}
        for (const ticker of tickers) {
          svToAdd[ticker] = symbolValues[ticker].map((sv, i) => sv * fxRate[i])
        }

        snrToAdd = {}
        for (const ticker of tickers) {
          snrToAdd[ticker] = symbolNetReturns[ticker].map((snr, i) => snr * fxRate[i])
        }

        scrToAdd = {}
        for (const ticker of tickers) {
          scrToAdd[ticker] = symbolCapitalReturns[ticker].map((scr, i) => scr * fxRate[i])
        }

        sdcToAdd = {}
        for (const ticker of tickers) {
          sdcToAdd[ticker] = symbolDivCashflows[ticker].map((sdc, i) => sdc * fxRate[i])
        }

        dispCurrency = 'USD'
      } else if (currency === 'AUD') {
        dispCurrency = 'AUD'
      } else {
        dispCurrency = 'USD'
      }

      pvParts.push(pvToAdd)
      nrParts.push(nrToAdd)
      crParts.push(crToAdd)
      drParts.push(drToAdd)
      svParts.push(svToAdd)
      snrParts.push(snrToAdd)
      scrParts.push(scrToAdd)
      sdcParts.push(sdcToAdd)
      allSortedDates = sortedDates
    }

    if (pvParts.length > 0) {
      portfolioGroups[portfolioName] = {
        portfolio_value: sumSeries(pvParts),
        net_return: sumSeries(nrParts),
        capital_return: sumSeries(crParts),
        dividend_return: sumSeries(drParts),
        symbol_values: sumDataFrames(svParts),
        symbol_net_returns: sumDataFrames(snrParts),
        symbol_capital_returns: sumDataFrames(scrParts),
        symbol_div_cashflows: sumDataFrames(sdcParts),
        display_currency: dispCurrency,
        dates: allSortedDates,
      }
    }
  }

  let benchmarkData: Record<string, { dates: string[]; values: number[] }> = {}
  if (benchmarkTickers.length > 0 && Object.keys(portfolioGroups).length > 0) {
    const bm_start = formatDate(
      new Date(Math.min(...Object.values(portfolioGroups).map(grp => parseDate(grp.dates[0]).getTime())))
    )
    const bm_end = formatDate(new Date())

    try {
      const resp = await api.post<PricesResponse>('/api/prices', {
        tickers: benchmarkTickers.map(t => ({ ticker: t, exchange: 'US' })),
        start: bm_start,
        end: bm_end,
      })

      for (const bm of benchmarkTickers) {
        if (bm in resp.data.prices) {
          benchmarkData[bm] = resp.data.prices[bm]
        }
      }
    } catch {
      // Ignore benchmark fetch failures
    }
  }

  const resultPortfolios: Record<string, PortfolioData> = {}
  for (const [name, grp] of Object.entries(portfolioGroups)) {
    const sv = grp.symbol_values
    const snr = grp.symbol_net_returns
    const scr = grp.symbol_capital_returns
    const sdc = grp.symbol_div_cashflows

    const symbols: Record<string, SymbolData> = {}
    for (const ticker of Object.keys(sv)) {
      symbols[ticker] = {
        value: sv[ticker] || [],
        net_return: snr[ticker] || [],
        capital_return: scr[ticker] || [],
        div_cashflow: sdc[ticker] || [],
      }
    }

    resultPortfolios[name] = {
      dates: grp.dates,
      portfolio_value: grp.portfolio_value,
      net_return: grp.net_return,
      capital_return: grp.capital_return,
      dividend_return: grp.dividend_return,
      display_currency: grp.display_currency,
      symbols,
    }
  }

  return {
    portfolios: resultPortfolios,
    benchmarks: benchmarkData,
    failed_tickers: fetchFailures,
  }
}
