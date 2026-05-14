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

// Most recent (non-zero, finite) FX value — used as the static "today's
// rate" scalar for computing the pure (no-FX-P&L) return series.
function latestFxRate(fxData: PriceData): number {
  for (let i = fxData.values.length - 1; i >= 0; i--) {
    const v = fxData.values[i]
    if (Number.isFinite(v) && v > 0) return v
  }
  return 1
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
  benchmarkTickers: string[] = [],
  displayCurrency: 'USD' | 'AUD' = 'USD'
): Promise<ComputeResult> {
  const empty: ComputeResult = {
    dates: [],
    portfolio_value: [],
    net_return: [],
    capital_return: [],
    dividend_return: [],
    capital_return_pure: [],
    dividend_return_pure: [],
    fx_return: [],
    display_currency: displayCurrency,
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
    // FX needed whenever native currency differs from display currency.
    // We only have AUDUSD=X, so any AUD/USD pairing routes through it.
    if (currency !== displayCurrency && (currency === 'AUD' || displayCurrency === 'AUD')) {
      fxCurrenciesNeeded.add('AUD')
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

  // Build a unified date axis from all instrument price series so that
  // multi-currency groups (e.g. ASX + US) share the same array length.
  // Without this, sumDataFrames receives arrays of different lengths and
  // pads the shorter one with trailing zeros, which causes
  // computeDayWeightedReturn to misinterpret the zeros as a position
  // collapse and produce 0% return for the shorter-history symbol.
  const unifiedDatesSet = new Set<string>()
  for (const data of Object.values(allPricesData)) {
    data.dates.forEach(d => unifiedDatesSet.add(d))
  }
  const unifiedDates = Array.from(unifiedDatesSet).sort()

  const pvParts: number[][] = []
  const nrParts: number[][] = []
  const crParts: number[][] = []
  const drParts: number[][] = []
  const crPureParts: number[][] = []
  const drPureParts: number[][] = []
  const fxRetParts: number[][] = []
  const svParts: Record<string, number[]>[] = []
  const snrParts: Record<string, number[]>[] = []
  const scrParts: Record<string, number[]>[] = []
  const sdcParts: Record<string, number[]>[] = []
  const scrPureParts: Record<string, number[]>[] = []
  const sdcPureParts: Record<string, number[]>[] = []
  const sfxRetParts: Record<string, number[]>[] = []
  let allSortedDates: string[] = unifiedDates

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

    // FX conversion factor: native → displayCurrency on each axis date.
    // We only have AUDUSD=X; USD→AUD just inverts it.
    let fxFeed: PriceData | null = null
    const needsFx = currency !== displayCurrency
    if (needsFx) {
      if (!fxData['AUD']) {
        fetchFailures.push(`${currency}: missing FX rate ${FX_SYMBOLS['AUD']}`)
        continue
      }
      fxFeed = fxData['AUD']
    }

    const sortedDates = unifiedDates

    // fxAxis: per-bar native→display rate, used for actual display values.
    // fxToday: scalar for the "pure" (FX-stripped) series at today's rate.
    let fxAxis: number[]
    let fxToday: number
    if (!needsFx) {
      fxAxis = new Array(sortedDates.length).fill(1)
      fxToday = 1
    } else {
      const audUsd = fxOnAxis(fxFeed!, sortedDates)
      const todayAudUsd = latestFxRate(fxFeed!)
      if (currency === 'AUD') {
        fxAxis = audUsd
        fxToday = todayAudUsd
      } else {
        fxAxis = audUsd.map(v => 1 / v)
        fxToday = 1 / todayAudUsd
      }
    }

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

    // Per-bar native amounts (no FX). Trade and dividend cashflows are kept
    // as per-bar increments (not yet cumulative) so we can scale them by
    // either fxAxis (per-bar) or fxToday (static) and then cumsum.
    const tradeBarNative: Record<string, number[]> = {}
    const divBarNative: Record<string, number[]> = {}
    for (const ticker of tickers) {
      const cfEvents = currencyTxns
        .filter(t => t.ticker === ticker && ['BUY', 'SELL'].includes(t.action))
        .map(t => ({ date: t.date, value: t.net_amount }))
      tradeBarNative[ticker] = alignToAxis(cfEvents, sortedDates)

      const divFeed = allDividendsData[ticker]
      const divAligned = new Array(sortedDates.length).fill(0)
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
          divAligned[idx] += shares * perShare
        }
      }
      divBarNative[ticker] = divAligned
    }

    // Native cumulative position value and cashflows (no FX applied).
    const pvNative: Record<string, number[]> = {}
    const tradeCfNative: Record<string, number[]> = {}
    const divCfNative: Record<string, number[]> = {}
    for (const ticker of tickers) {
      pvNative[ticker] = positions[ticker].map((pos, i) => pos === 0 ? 0 : pos * prices[ticker][i])
      tradeCfNative[ticker] = cumsum(tradeBarNative[ticker])
      divCfNative[ticker] = cumsum(divBarNative[ticker])
    }

    // Display series (per-bar FX): true display-currency value of the
    // position at each bar, with each cashflow converted at the FX rate
    // on its own date. This captures real FX P&L over the holding period.
    const symbolValues: Record<string, number[]> = {}
    const symbolTradeCashflows: Record<string, number[]> = {}
    const symbolDivCashflows: Record<string, number[]> = {}
    for (const ticker of tickers) {
      symbolValues[ticker] = pvNative[ticker].map((v, i) => v * fxAxis[i])
      symbolTradeCashflows[ticker] = cumsum(tradeBarNative[ticker].map((v, i) => v * fxAxis[i]))
      symbolDivCashflows[ticker] = cumsum(divBarNative[ticker].map((v, i) => v * fxAxis[i]))
    }

    const symbolNetReturns: Record<string, number[]> = {}
    const symbolCapitalReturns: Record<string, number[]> = {}
    for (const ticker of tickers) {
      symbolNetReturns[ticker] = symbolValues[ticker].map(
        (v, i) => v + (symbolTradeCashflows[ticker][i] || 0) + (symbolDivCashflows[ticker][i] || 0),
      )
      symbolCapitalReturns[ticker] = symbolNetReturns[ticker].map(
        (nr, i) => nr - (symbolDivCashflows[ticker][i] || 0),
      )
    }

    // Pure series (static today-FX): instrument-only return, with FX
    // applied as a single uniform scalar. The difference between the
    // per-bar and pure series is attributed to fx_return below.
    const symbolCapitalReturnsPure: Record<string, number[]> = {}
    const symbolDivCashflowsPure: Record<string, number[]> = {}
    const symbolFxReturns: Record<string, number[]> = {}
    for (const ticker of tickers) {
      symbolCapitalReturnsPure[ticker] = pvNative[ticker].map(
        (v, i) => (v + tradeCfNative[ticker][i]) * fxToday,
      )
      symbolDivCashflowsPure[ticker] = divCfNative[ticker].map(v => v * fxToday)
      symbolFxReturns[ticker] = symbolNetReturns[ticker].map(
        (nr, i) => nr - symbolCapitalReturnsPure[ticker][i] - symbolDivCashflowsPure[ticker][i],
      )
    }

    const sumOver = (per: Record<string, number[]>): number[] =>
      sortedDates.map((_, i) => tickers.reduce((s, t) => s + (per[t][i] || 0), 0))

    const portfolioValue = sumOver(symbolValues)
    const netReturn = sumOver(symbolNetReturns)
    const capitalReturn = sumOver(symbolCapitalReturns)
    const totalDivCashflows = sumOver(symbolDivCashflows)
    const capitalReturnPure = sumOver(symbolCapitalReturnsPure)
    const totalDivCashflowsPure = sumOver(symbolDivCashflowsPure)
    const fxReturn = sumOver(symbolFxReturns)

    pvParts.push(portfolioValue)
    nrParts.push(netReturn)
    crParts.push(capitalReturn)
    drParts.push(totalDivCashflows)
    crPureParts.push(capitalReturnPure)
    drPureParts.push(totalDivCashflowsPure)
    fxRetParts.push(fxReturn)
    svParts.push(symbolValues)
    snrParts.push(symbolNetReturns)
    scrParts.push(symbolCapitalReturns)
    sdcParts.push(symbolDivCashflows)
    scrPureParts.push(symbolCapitalReturnsPure)
    sdcPureParts.push(symbolDivCashflowsPure)
    sfxRetParts.push(symbolFxReturns)
  }

  if (pvParts.length === 0) {
    return { ...empty, failed_tickers: fetchFailures }
  }

  const sv = sumDataFrames(svParts)
  const snr = sumDataFrames(snrParts)
  const scr = sumDataFrames(scrParts)
  const sdc = sumDataFrames(sdcParts)
  const scrPure = sumDataFrames(scrPureParts)
  const sdcPure = sumDataFrames(sdcPureParts)
  const sfx = sumDataFrames(sfxRetParts)

  const symbols: Record<string, SymbolData> = {}
  for (const ticker of Object.keys(sv)) {
    symbols[ticker] = {
      value: sv[ticker] || [],
      net_return: snr[ticker] || [],
      capital_return: scr[ticker] || [],
      div_cashflow: sdc[ticker] || [],
      capital_return_pure: scrPure[ticker] || [],
      div_cashflow_pure: sdcPure[ticker] || [],
      fx_return: sfx[ticker] || [],
    }
  }

  // Per-bar trade cashflows in display currency (negative = buy, positive = sell).
  // Derived from the aggregate capital_return and portfolio_value series:
  //   cumTradeCf[i] = capitalReturn[i] - portfolioValue[i]
  //   tradeCfBar[i] = cumTradeCf[i] - cumTradeCf[i-1]
  const aggPortfolioValue = sumSeries(pvParts)
  const aggCapitalReturn = sumSeries(crParts)
  const cumTradeCf = aggCapitalReturn.map((cr, i) => cr - aggPortfolioValue[i])
  const tradeCfBar = cumTradeCf.map((v, i) => v - (i > 0 ? cumTradeCf[i - 1] : 0))

  let benchmarkData: Record<string, { dates: string[]; portfolio_value: number[]; net_return: number[] }> = {}
  if (benchmarkTickers.length > 0 && allSortedDates.length > 0) {
    const bm_start = formatDate(parseDate(allSortedDates[0]))
    const bm_end = formatDate(new Date())

    try {
      const resp = await api.post<PricesResponse>('/api/prices', {
        tickers: benchmarkTickers.map(t => ({ ticker: t, exchange: 'US' })),
        start: bm_start,
        end: bm_end,
      })

      // Convert USD benchmark prices to display currency if needed.
      let benchmarkFxAxis: number[] | null = null
      if (displayCurrency === 'AUD' && fxData['AUD']) {
        const audUsd = fxOnAxis(fxData['AUD'], allSortedDates)
        benchmarkFxAxis = audUsd.map(v => 1 / v)
      }

      for (const bm of benchmarkTickers) {
        if (!(bm in resp.data.prices)) continue
        const bmRaw = resp.data.prices[bm]

        const bmPricesUSD = forwardFillPrices(bmRaw.values, bmRaw.dates, allSortedDates)
        const bmPricesDisplay = benchmarkFxAxis
          ? bmPricesUSD.map((p, i) => p * benchmarkFxAxis![i])
          : bmPricesUSD

        // Simulate: for each trade, invest/divest the same notional in the benchmark.
        // unitsChange[i] = -tradeCfBar[i] / bmPrice[i]
        //   (tradeCfBar < 0 for buys → positive units; > 0 for sells → negative units)
        let cumulativeUnits = 0
        const bmPortfolioValue: number[] = []

        for (let i = 0; i < allSortedDates.length; i++) {
          const bmPrice = bmPricesDisplay[i]
          if (Number.isFinite(bmPrice) && bmPrice > 0 && tradeCfBar[i] !== 0) {
            cumulativeUnits += -tradeCfBar[i] / bmPrice
          }
          bmPortfolioValue.push(Number.isFinite(bmPrice) && bmPrice > 0 ? cumulativeUnits * bmPrice : 0)
        }

        // Benchmark net return uses the same cumulative cost basis as the actual portfolio.
        const bmNetReturn = bmPortfolioValue.map((v, i) => v + cumTradeCf[i])

        benchmarkData[bm] = {
          dates: allSortedDates,
          portfolio_value: bmPortfolioValue,
          net_return: bmNetReturn,
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
    capital_return_pure: sumSeries(crPureParts),
    dividend_return_pure: sumSeries(drPureParts),
    fx_return: sumSeries(fxRetParts),
    display_currency: displayCurrency,
    symbols,
    benchmarks: benchmarkData,
    failed_tickers: fetchFailures,
  }
}
