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
      const startDate = new Date(Math.min(...tradeRows.map(t => parseDate(t.date).getTime())))
      const endDate = new Date()
      endDate.setUTCDate(endDate.getUTCDate() + 1)

      const startStr = formatDate(startDate)
      const endStr = formatDate(endDate)

      let pricesData: Record<string, PriceData> = {}
      let failedTickers: string[] = []

      try {
        const priceTickets = tickers.map(t => ({ ticker: t, exchange }))
        if (currency === 'AUD') {
          priceTickets.push({ ticker: 'AUDUSD=X', exchange: 'US' })
        }

        const resp = await api.post<PricesResponse>('/api/prices', {
          tickers: priceTickets,
          start: startStr,
          end: endStr,
        })

        pricesData = resp.data.prices
        failedTickers = resp.data.failed || []
      } catch (err) {
        failedTickers = tickers
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

      const signedQties: Record<string, Record<string, number>> = {}
      for (const txn of tradeRows) {
        const txnDate = txn.date
        if (!(txnDate in signedQties)) {
          signedQties[txnDate] = {}
        }
        const signedQty = txn.action === 'BUY' ? txn.quantity : -txn.quantity
        signedQties[txnDate][txn.ticker] = (signedQties[txnDate][txn.ticker] || 0) + signedQty
      }

      const positions: Record<string, number[]> = {}
      for (const ticker of tickers) {
        positions[ticker] = Array(sortedDates.length).fill(0)
      }

      let cumQties: Record<string, number> = {}
      for (const ticker of tickers) {
        cumQties[ticker] = 0
      }

      for (let i = 0; i < sortedDates.length; i++) {
        const date = sortedDates[i]
        if (date in signedQties) {
          for (const ticker in signedQties[date]) {
            cumQties[ticker] += signedQties[date][ticker]
          }
        }
        for (const ticker of tickers) {
          positions[ticker][i] = cumQties[ticker]
        }
      }

      const symbolValues: Record<string, number[]> = {}
      for (const ticker of tickers) {
        symbolValues[ticker] = positions[ticker].map((pos, i) => pos * prices[ticker][i])
      }

      const portfolioValue = symbolValues[tickers[0]].map((_, i) => {
        return tickers.reduce((sum, t) => sum + (symbolValues[t][i] || 0), 0)
      })

      const symbolCashflows: Record<string, number[]> = {}
      for (const ticker of tickers) {
        symbolCashflows[ticker] = Array(sortedDates.length).fill(0)
      }

      const cashflowsByDate: Record<string, Record<string, number>> = {}
      for (const txn of currencyTxns) {
        if (!['BUY', 'SELL', 'DIV'].includes(txn.action)) continue
        if (!(txn.date in cashflowsByDate)) {
          cashflowsByDate[txn.date] = {}
        }
        if (!(txn.ticker in cashflowsByDate[txn.date])) {
          cashflowsByDate[txn.date][txn.ticker] = 0
        }
        cashflowsByDate[txn.date][txn.ticker] += txn.net_amount
      }

      let cumCashflows: Record<string, number> = {}
      for (const ticker of tickers) {
        cumCashflows[ticker] = 0
      }

      for (let i = 0; i < sortedDates.length; i++) {
        const date = sortedDates[i]
        if (date in cashflowsByDate) {
          for (const ticker in cashflowsByDate[date]) {
            cumCashflows[ticker] = (cumCashflows[ticker] || 0) + cashflowsByDate[date][ticker]
          }
        }
        for (const ticker of tickers) {
          symbolCashflows[ticker][i] = cumCashflows[ticker] || 0
        }
      }

      const symbolNetReturns: Record<string, number[]> = {}
      for (const ticker of tickers) {
        symbolNetReturns[ticker] = symbolValues[ticker].map((v, i) => v + (symbolCashflows[ticker][i] || 0))
      }

      const totalCashflows = sortedDates.map((_, i) => tickers.reduce((sum, t) => sum + (symbolCashflows[t][i] || 0), 0))
      const netReturn = portfolioValue.map((pv, i) => pv + totalCashflows[i])

      const symbolDivCashflows: Record<string, number[]> = {}
      for (const ticker of tickers) {
        symbolDivCashflows[ticker] = Array(sortedDates.length).fill(0)
      }

      const divCashflowsByDate: Record<string, Record<string, number>> = {}
      for (const txn of currencyTxns) {
        if (txn.action !== 'DIV') continue
        if (!(txn.date in divCashflowsByDate)) {
          divCashflowsByDate[txn.date] = {}
        }
        if (!(txn.ticker in divCashflowsByDate[txn.date])) {
          divCashflowsByDate[txn.date][txn.ticker] = 0
        }
        divCashflowsByDate[txn.date][txn.ticker] += txn.net_amount
      }

      let cumDivCashflows: Record<string, number> = {}
      for (const ticker of tickers) {
        cumDivCashflows[ticker] = 0
      }

      for (let i = 0; i < sortedDates.length; i++) {
        const date = sortedDates[i]
        if (date in divCashflowsByDate) {
          for (const ticker in divCashflowsByDate[date]) {
            cumDivCashflows[ticker] = (cumDivCashflows[ticker] || 0) + divCashflowsByDate[date][ticker]
          }
        }
        for (const ticker of tickers) {
          symbolDivCashflows[ticker][i] = cumDivCashflows[ticker] || 0
        }
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
        const fxRate = forwardFillPrices(fxData.values, fxData.dates, sortedDates)

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
