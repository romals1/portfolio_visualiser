export interface Transaction {
  date: string
  ticker: string
  action: string
  quantity: number
  price: number
  fees: number
  exchange: string
  currency: string
}

export interface SymbolData {
  value: number[]
  net_return: number[]
  capital_return: number[]
  div_cashflow: number[]
  capital_return_pure: number[]
  div_cashflow_pure: number[]
  fx_return: number[]
}

export interface BenchmarkData {
  dates: string[]
  values: number[]
}

export interface ComputeResult {
  dates: string[]
  portfolio_value: number[]
  net_return: number[]
  capital_return: number[]
  dividend_return: number[]
  capital_return_pure: number[]
  dividend_return_pure: number[]
  fx_return: number[]
  display_currency: string
  symbols: Record<string, SymbolData>
  benchmarks: Record<string, BenchmarkData>
  failed_tickers: string[]
}
