import { Transaction, ComputeResult, SymbolData } from '../types'
import api from '../api/client'

interface TransactionWithFields extends Transaction {
  currency: string
  net_amount: number
}

interface PriceData {
  dates: string[]
  values: number[]
}

interface PricesResponse {
  prices: Record<string, PriceData>
  dividends?: Record<string, PriceData>
  failed: string[]
}

const FX_SYMBOLS: Record<string, string> = {
  AUD: 'AUDUSD=X',
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

// Forward + back fill a (sparse) FX series onto a target axis. The first
// trading day for a currency may precede the first FX bar by a day or two
// (e.g. an AUD trade on a Monday, FX series starting Tuesday) — back fill
// covers that leading gap so we never multiply by NaN.
function fxOnAxis(fxData: PriceData, axis: string[]): number[] {
  const forward = forwardFillPrices(fxData.values, fxData.dates, axis)
  const firstReal = fxData.values.length > 0 ? fxData.values[0] : 1
  return forward.map(v => (Number.isFinite(v) ? v : firstReal))
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
  const empty: ComputeResult = {
    dates: [],
    portfolio_value: [],
    net_return: [],
    capital_return: [],
    dividend_return: [],
    display_currency: 'USD',
    symbols: {},
    benchmarks: {},
    failed_tickers: [],
  }

  if (transactions.length === 0) return empty

  const txns: TransactionWithFields[] = transactions.map(t => ({
    ...t,
    currency: t.currency || (t.exchange === 'ASX' ? 'AUD' : 'USD'),
    net_amount:
      t.action === 'BUY'
        ? -(t.quantity * t.price + (t.fees || 0))
        : t.quantity * t.price - (t.fees || 0),
  }))

  let fetchFailures: string[] = []

  // Collect all ticker/exchange pairs needed
  const allTickersToFetch = new Set<string>()
  const fxCurrenciesNeeded = new Set<string>()

  const currencyMap = new Map<string, TransactionWithFields[]>()
  for (const txn of txns) {
    const key = txn.currency
    if (!currencyMap.has(key)) currencyMap.set(key, [])
    currencyMap.get(key)!.push(txn)
  }

  for (const [currency, currencyTxns] of currencyMap) {
    const tradeRows = currencyTxns.filter(t => ['BUY', 'SELL'].includes(t.action))
    if (tradeRows.length === 0) continue
    const exchange = tradeRows[0].exchange
    for (const txn of tradeRows) {
      allTickersToFetch.add(`${exchange}:${txn.ticker}`)
    }
    if (currency !== 'USD' && FX_SYMBOLS[currency]) {
      fxCurrenciesNeeded.add(currency)
    }
  }

  // Calculate min transaction date
  let minTxnDate = formatDate(new Date())
  if (txns.length > 0) {
    minTxnDate = txns.reduce((min, t) => t.date < min ? t.date : min, txns[0].date)
  }

  const startDate = new Date(minTxnDate + 'T00:00:00Z')
  const endDate = new Date()
  endDate.setUTCDate(endDate.getUTCDate() + 1)

  const startStr = formatDate(startDate)
  const endStr = formatDate(endDate)

  // Single batched fetch for instrument prices + FX rates needed for conversion.
  let allPricesData: Record<string, PriceData> = {}
  let allDividendsData: Record<string, PriceData> = {}
  const fxData: Record<string, PriceData> = {}
  if (allTickersToFetch.size > 0 || fxCurrenciesNeeded.size > 0) {
    try {
      const ticketList = Array.from(allTickersToFetch).map(key => {
        const [exchange, ticker] = key.split(':')
        return { ticker, exchange }
      })
      for (const ccy of fxCurrenciesNeeded) {
        ticketList.push({ ticker: FX_SYMBOLS[ccy], exchange: 'US' })
      }
      const resp = await api.post<PricesResponse>('/api/prices', {
        tickers: ticketList,
        start: startStr,
        end: endStr,
      })
      allPricesData = resp.data.prices
      allDividendsData = resp.data.dividends || {}

      for (const ccy of fxCurrenciesNeeded) {
        const sym = FX_SYMBOLS[ccy]
        const series = allPricesData[sym]
        if (series) {
          fxData[ccy] = series
          delete allPricesData[sym]
        }
      }
    } catch {
      // failures propagated per-ticker below
    }
  }

  const pvParts: number[][] = []
  const nrParts: number[][] = []
  const crParts: number[][] = []
  const drParts: number[][] = []
  const svParts: Record<string, number[]>[] = []
  const snrParts: Record<string, number[]>[] = []
  const scrParts: Record<string, number[]>[] = []
  const sdcParts: Record<string, number[]>[] = []
  let allSortedDates: string[] = []

  for (const [currency, currencyTxns] of currencyMap) {
    const tradeRows = currencyTxns.filter(t => ['BUY', 'SELL'].includes(t.action))
    if (tradeRows.length === 0) continue

    const tickers = Array.from(new Set(tradeRows.map(t => t.ticker)))

    let pricesData: Record<string, PriceData> = {}
    for (const ticker of tickers) {
      if (ticker in allPricesData) {
        pricesData[ticker] = allPricesData[ticker]
      }
    }

    const missingTickers = tickers.filter(t => !(t in pricesData))
    if (missingTickers.length > 0) {
      fetchFailures.push(...missingTickers.map(t => `${currency}: ${t}`))
      continue
    }

    if (Object.keys(pricesData).length === 0) {
      fetchFailures.push(`${currency}: no price data`)
      continue
    }

    // FX series → USD. USD currency uses an all-ones array.
    let fxFeed: PriceData | null = null
    if (currency !== 'USD') {
      const fxSym = FX_SYMBOLS[currency]
      if (!fxSym || !fxData[currency]) {
        fetchFailures.push(`${currency}: missing FX rate ${fxSym ?? '?'}`)
        continue
      }
      fxFeed = fxData[currency]
    }

    const allDates = new Set<string>()
    for (const ticker in pricesData) {
      pricesData[ticker].dates.forEach(d => allDates.add(d))
    }
    const sortedDates = Array.from(allDates).sort()

    const fxAxis: number[] = fxFeed
      ? fxOnAxis(fxFeed, sortedDates)
      : new Array(sortedDates.length).fill(1)

    const prices: Record<string, number[]> = {}
    for (const ticker of tickers) {
      const data = pricesData[ticker]
      prices[ticker] = forwardFillPrices(data.values, data.dates, sortedDates)
    }

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

    // Position value in USD: shares × native price × FX(date)
    const symbolValues: Record<string, number[]> = {}
    for (const ticker of tickers) {
      symbolValues[ticker] = positions[ticker].map(
        (pos, i) => pos * prices[ticker][i] * fxAxis[i]
      )
    }

    const portfolioValue = symbolValues[tickers[0]].map((_, i) => {
      return tickers.reduce((sum, t) => sum + (symbolValues[t][i] || 0), 0)
    })

    // Per-symbol dividend cashflows in USD: shares × per-share native ×
    // FX rate on the aligned bar's date. yfinance is the authoritative
    // dividend source — user CSV DIV rows are ignored.
    const symbolDivCashflows: Record<string, number[]> = {}
    for (const ticker of tickers) {
      const divFeed = allDividendsData[ticker]
      const aligned = new Array(sortedDates.length).fill(0)
      if (divFeed) {
        const dateToIdx = new Map(sortedDates.map((d, i) => [d, i]))
        for (let k = 0; k < divFeed.dates.length; k++) {
          const exDate = divFeed.dates[k]
          const perShare = divFeed.values[k]
          let idx = dateToIdx.get(exDate)
          if (idx === undefined) {
            idx = sortedDates.findIndex(d => d >= exDate)
            if (idx < 0) continue
          }
          const shares = positions[ticker][idx] ?? 0
          if (shares <= 0) continue
          aligned[idx] += shares * perShare * fxAxis[idx]
        }
      }
      symbolDivCashflows[ticker] = cumsum(aligned)
    }

    // Trade cashflows in USD: net_amount on each trade date × FX on that
    // axis date. Converting at the time the cashflow happened (not at the
    // current FX rate) preserves the historical USD value of the cashflow.
    const symbolTradeCashflows: Record<string, number[]> = {}
    for (const ticker of tickers) {
      const cfEvents = currencyTxns
        .filter(t => t.ticker === ticker && ['BUY', 'SELL'].includes(t.action))
        .map(t => ({
          date: t.date,
          value: t.net_amount,
        }))
      const alignedNative = alignToAxis(cfEvents, sortedDates)
      const alignedUsd = alignedNative.map((v, i) => v * fxAxis[i])
      symbolTradeCashflows[ticker] = cumsum(alignedUsd)
    }

    const symbolCashflows: Record<string, number[]> = {}
    for (const ticker of tickers) {
      symbolCashflows[ticker] = symbolTradeCashflows[ticker].map(
        (v, i) => v + (symbolDivCashflows[ticker][i] || 0)
      )
    }

    const symbolNetReturns: Record<string, number[]> = {}
    for (const ticker of tickers) {
      symbolNetReturns[ticker] = symbolValues[ticker].map((v, i) => v + (symbolCashflows[ticker][i] || 0))
    }

    const totalCashflows = sortedDates.map((_, i) => tickers.reduce((sum, t) => sum + (symbolCashflows[t][i] || 0), 0))
    const netReturn = portfolioValue.map((pv, i) => pv + totalCashflows[i])

    const symbolCapitalReturns: Record<string, number[]> = {}
    for (const ticker of tickers) {
      symbolCapitalReturns[ticker] = symbolNetReturns[ticker].map((nr, i) => nr - (symbolDivCashflows[ticker][i] || 0))
    }

    const totalDivCashflows = sortedDates.map((_, i) => tickers.reduce((sum, t) => sum + (symbolDivCashflows[t][i] || 0), 0))
    const capitalReturn = netReturn.map((nr, i) => nr - totalDivCashflows[i])

    pvParts.push(portfolioValue)
    nrParts.push(netReturn)
    crParts.push(capitalReturn)
    drParts.push(totalDivCashflows)
    svParts.push(symbolValues)
    snrParts.push(symbolNetReturns)
    scrParts.push(symbolCapitalReturns)
    sdcParts.push(symbolDivCashflows)
    allSortedDates = sortedDates
  }

  if (pvParts.length === 0) {
    return { ...empty, failed_tickers: fetchFailures }
  }

  const sv = sumDataFrames(svParts)
  const snr = sumDataFrames(snrParts)
  const scr = sumDataFrames(scrParts)
  const sdc = sumDataFrames(sdcParts)

  const symbols: Record<string, SymbolData> = {}
  for (const ticker of Object.keys(sv)) {
    symbols[ticker] = {
      value: sv[ticker] || [],
      net_return: snr[ticker] || [],
      capital_return: scr[ticker] || [],
      div_cashflow: sdc[ticker] || [],
    }
  }

  let benchmarkData: Record<string, { dates: string[]; values: number[] }> = {}
  if (benchmarkTickers.length > 0 && allSortedDates.length > 0) {
    const bm_start = formatDate(parseDate(allSortedDates[0]))
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

  return {
    dates: allSortedDates,
    portfolio_value: sumSeries(pvParts),
    net_return: sumSeries(nrParts),
    capital_return: sumSeries(crParts),
    dividend_return: sumSeries(drParts),
    display_currency: 'USD',
    symbols,
    benchmarks: benchmarkData,
    failed_tickers: fetchFailures,
  }
}
