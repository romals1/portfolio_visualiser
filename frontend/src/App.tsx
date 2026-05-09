import { useState, useEffect, useRef } from 'react'
import Auth from './components/Auth'
import FileUpload from './components/FileUpload'
import TransactionTable from './components/TransactionTable'
import ChartArea from './components/ChartArea'
import PortfolioStats from './components/PortfolioStats'
import { Transaction, ComputeResult } from './types'
import api from './api/client'
import supabase from './api/supabase'
import { computePortfolio } from './lib/computation'

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'))
  const [userEmail, setUserEmail] = useState<string | null>(() => localStorage.getItem('user_email'))
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [computeResult, setComputeResult] = useState<ComputeResult | null>(null)
  const [isComputing, setIsComputing] = useState(false)
  const [computeError, setComputeError] = useState<string | null>(null)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleLogin = (tok: string, email: string) => {
    localStorage.setItem('auth_token', tok)
    localStorage.setItem('user_email', email)
    setToken(tok)
    setUserEmail(email)
  }

  const handleLogout = async () => {
    try { await api.post('/api/auth/logout') } catch { /* ignore */ }
    try { await supabase?.auth.signOut() } catch { /* ignore */ }
    localStorage.removeItem('auth_token')
    localStorage.removeItem('user_email')
    setToken(null)
    setUserEmail(null)
    setTransactions([])
    setComputeResult(null)
  }

  const handleTransactionsParsed = (newTxns: Transaction[]) => {
    setTransactions((prev: Transaction[]) => {
      const newPortfolios = new Set(newTxns.map((t: Transaction) => t.portfolio))
      const kept = prev.filter((t: Transaction) => !newPortfolios.has(t.portfolio))
      return [...kept, ...newTxns].sort((a: Transaction, b: Transaction) => a.date.localeCompare(b.date))
    })
    setComputeResult(null)
    setComputeError(null)
  }

  const handleClearTransactions = () => {
    setTransactions([])
    setComputeResult(null)
    setComputeError(null)
  }

  const handleCompute = async (benchmarkTickers: string[]) => {
    if (transactions.length === 0) return
    setIsComputing(true)
    setComputeError(null)
    try {
      const result = await computePortfolio(transactions, benchmarkTickers)
      setComputeResult(result)
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } }; message?: string })
          ?.response?.data?.detail ??
        (err as { message?: string })?.message ??
        'Computation failed'
      setComputeError(detail)
    } finally {
      setIsComputing(false)
    }
  }

  const handleClearCache = async () => {
    try { await api.post('/api/portfolio/clear-cache') } catch { /* ignore */ }
  }

  // Load transactions on mount when token is available
  useEffect(() => {
    if (!token) return

    const loadTransactions = async () => {
      try {
        const resp = await api.get('/api/transactions')
        if (resp.data?.transactions && Array.isArray(resp.data.transactions)) {
          setTransactions(resp.data.transactions)
        }
      } catch {
        // Silently fail if endpoint not available (e.g., Supabase not configured)
      }
    }

    loadTransactions()
  }, [token])

  // Debounced save transactions whenever they change
  useEffect(() => {
    if (!token || transactions.length === 0) return

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await api.put('/api/transactions', { transactions })
      } catch {
        // Silently fail if endpoint not available
      }
    }, 800)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [transactions, token])

  useEffect(() => {
    if (!supabase) return

    const checkSession = async () => {
      if (!supabase) return
      const { data } = await supabase.auth.getSession()
      if (data.session?.user) {
        const userEmail = data.session.user.email || ''
        const accessToken = data.session.access_token
        handleLogin(accessToken, userEmail)
      }
    }

    checkSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event: any, session: any) => {
      if (event === 'SIGNED_IN' && session?.user) {
        const userEmail = session.user.email || ''
        const accessToken = session.access_token
        handleLogin(accessToken, userEmail)
      } else if (event === 'INITIAL_SESSION' && !token && session?.user) {
        const userEmail = session.user.email || ''
        const accessToken = session.access_token
        handleLogin(accessToken, userEmail)
      } else if (event === 'SIGNED_OUT') {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('user_email')
        setToken(null)
        setUserEmail(null)
      }
    })

    return () => {
      subscription?.unsubscribe()
    }
  }, [token])

  if (!token) {
    return <Auth onLogin={handleLogin} />
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Portfolio Returns Viz</h1>
        <div className="flex items-center gap-4">
          {userEmail && <span className="text-sm text-gray-400">{userEmail}</span>}
          <button
            onClick={handleLogout}
            className="text-sm text-gray-400 hover:text-white transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {computeResult && <PortfolioStats result={computeResult} />}

        <FileUpload onTransactionsParsed={handleTransactionsParsed} onClear={handleClearTransactions} />

        {transactions.length > 0 && (
          <>
            <TransactionTable
              transactions={transactions}
              onChange={setTransactions}
            />
            <ChartArea
              transactions={transactions}
              computeResult={computeResult}
              isComputing={isComputing}
              computeError={computeError}
              onCompute={handleCompute}
              onClearCache={handleClearCache}
            />
          </>
        )}
      </main>
    </div>
  )
}
