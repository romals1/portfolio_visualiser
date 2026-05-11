import { useState, useEffect, useRef } from 'react'
import Auth from './components/Auth'
import UploadModal from './components/UploadModal'
import TransactionTable from './components/TransactionTable'
import HoldingsTable from './components/HoldingsTable'
import ChartArea from './components/ChartArea'
import PortfolioStats from './components/PortfolioStats'
import Tabs from './components/Tabs'
import Spinner from './components/Spinner'
import { Transaction, ComputeResult } from './types'
import api from './api/client'
import supabase from './api/supabase'
import { computePortfolio } from './lib/computation'

const authEnabled = supabase !== null

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'))
  const [userEmail, setUserEmail] = useState<string | null>(() => localStorage.getItem('user_email'))
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [computeResult, setComputeResult] = useState<ComputeResult | null>(null)
  const [isComputing, setIsComputing] = useState(false)
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(false)
  const [computeError, setComputeError] = useState<string | null>(null)
  const [benchmarkTickers, setBenchmarkTickers] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<'transactions' | 'holdings' | 'chart'>('transactions')
  const [uploadOpen, setUploadOpen] = useState(false)
  const computeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const computeRequestIdRef = useRef(0)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasLoadedRef = useRef(false)
  const loadCancelledRef = useRef(false)
  const skipNextSaveRef = useRef(false)

  const handleLogin = (tok: string, email: string) => {
    localStorage.setItem('auth_token', tok)
    localStorage.setItem('user_email', email)
    setToken(tok)
    setUserEmail(email)
  }

  const handleLogout = async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      /* ignore */
    }
    try {
      await supabase?.auth.signOut()
    } catch {
      /* ignore */
    }
    localStorage.removeItem('auth_token')
    localStorage.removeItem('user_email')
    setToken(null)
    setUserEmail(null)
    setTransactions([])
    setComputeResult(null)
  }

  const handleTransactionsParsed = (newTxns: Transaction[]) => {
    // User is taking action; ensure any in-flight initial load can't overwrite this.
    loadCancelledRef.current = true
    hasLoadedRef.current = true
    setTransactions((prev: Transaction[]) => {
      const newPortfolios = new Set(newTxns.map((t: Transaction) => t.portfolio))
      const kept = prev.filter((t: Transaction) => !newPortfolios.has(t.portfolio))
      return [...kept, ...newTxns].sort((a: Transaction, b: Transaction) => a.date.localeCompare(b.date))
    })
    setComputeResult(null)
    setComputeError(null)
  }

  const performCompute = async (txns: Transaction[], benchmarks: string[]) => {
    if (txns.length === 0) return
    const requestId = ++computeRequestIdRef.current
    setIsComputing(true)
    setComputeError(null)
    try {
      const result = await computePortfolio(txns, benchmarks)
      if (requestId !== computeRequestIdRef.current) return
      setComputeResult(result)
    } catch (err: unknown) {
      if (requestId !== computeRequestIdRef.current) return
      const detail =
        (err as { response?: { data?: { detail?: string } }; message?: string })
          ?.response?.data?.detail ??
        (err as { message?: string })?.message ??
        'Computation failed'
      setComputeError(detail)
    } finally {
      if (requestId === computeRequestIdRef.current) {
        setIsComputing(false)
      }
    }
  }

  const handleClearCache = async () => {
    try {
      await api.post('/api/portfolio/clear-cache')
    } catch {
      /* ignore */
    }
  }

  // Auto-compute when transactions or benchmarks change
  useEffect(() => {
    if (transactions.length === 0) return

    if (computeTimeoutRef.current) {
      clearTimeout(computeTimeoutRef.current)
    }

    computeTimeoutRef.current = setTimeout(() => {
      performCompute(transactions, benchmarkTickers)
    }, 500)

    return () => {
      if (computeTimeoutRef.current) {
        clearTimeout(computeTimeoutRef.current)
      }
    }
  }, [transactions, benchmarkTickers])

  // Load transactions on mount when token is available
  useEffect(() => {
    if (!token) return
    // Reset per-session: a new token means a new user/login.
    hasLoadedRef.current = false
    loadCancelledRef.current = false
    skipNextSaveRef.current = false

    const loadTransactions = async () => {
      setIsLoadingTransactions(true)
      try {
        const resp = await api.get('/api/transactions')
        // If the user uploaded/cleared while we were loading, drop the result.
        if (loadCancelledRef.current) return
        if (resp.data?.transactions && Array.isArray(resp.data.transactions)) {
          // Mark load complete and tell the save effect to ignore the
          // upcoming state-change echo of the freshly-loaded data.
          hasLoadedRef.current = true
          if (resp.data.transactions.length > 0) {
            skipNextSaveRef.current = true
          }
          setTransactions(resp.data.transactions)
          return
        }
        hasLoadedRef.current = true
      } catch {
        // Silently fail if endpoint not available (e.g., Supabase not configured)
        hasLoadedRef.current = true
      } finally {
        setIsLoadingTransactions(false)
      }
    }

    loadTransactions()
  }, [token])

  // Debounced save transactions whenever they change (after initial load completes)
  useEffect(() => {
    if (!token) return
    // Skip the initial-load write-back: don't save until load has finished.
    if (!hasLoadedRef.current) return
    // Skip the echo of the freshly-loaded data.
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }

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

  // Flush pending save immediately on tab close so no edits are lost
  useEffect(() => {
    if (!token) return
    const handleBeforeUnload = () => {
      if (!hasLoadedRef.current) return
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
      fetch('/api/transactions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ transactions }),
        keepalive: true,
      }).catch(() => {})
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [token, transactions])

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

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event: any, session: any) => {
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

  if (authEnabled && !token) {
    return <Auth onLogin={handleLogin} />
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Portfolio Returns Viz</h1>
        {authEnabled && (
          <div className="flex items-center gap-4">
            {userEmail && <span className="text-sm text-gray-400">{userEmail}</span>}
            <button
              onClick={handleLogout}
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              Logout
            </button>
          </div>
        )}
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {computeResult && <PortfolioStats result={computeResult} />}

        {isLoadingTransactions && transactions.length === 0 && (
          <div className="flex items-center justify-center gap-3 py-8 text-gray-400">
            <Spinner size={20} />
            <span className="text-sm">Loading saved transactions…</span>
          </div>
        )}

        {!isLoadingTransactions && transactions.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-gray-400">
            <p className="text-sm">No transactions loaded.</p>
            <button
              onClick={() => setUploadOpen(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Upload CSV
            </button>
          </div>
        )}

        {transactions.length > 0 && (
          <div className="space-y-4">
            <Tabs
              tabs={[
                { id: 'transactions', label: 'Transactions' },
                { id: 'holdings', label: 'Holdings' },
                { id: 'chart', label: 'Chart' },
              ]}
              active={activeTab}
              onChange={(id) => setActiveTab(id as 'transactions' | 'holdings' | 'chart')}
            />
            <div role="tabpanel" className={activeTab === 'transactions' ? '' : 'hidden'}>
              <TransactionTable
                transactions={transactions}
                onChange={setTransactions}
                onUpload={() => setUploadOpen(true)}
              />
            </div>
            <div role="tabpanel" className={activeTab === 'holdings' ? '' : 'hidden'}>
              <HoldingsTable result={computeResult} />
            </div>
            <div role="tabpanel" className={activeTab === 'chart' ? '' : 'hidden'}>
              <ChartArea
                transactions={transactions}
                computeResult={computeResult}
                isComputing={isComputing}
                computeError={computeError}
                benchmarkTickers={benchmarkTickers}
                onBenchmarkChange={setBenchmarkTickers}
                onClearCache={handleClearCache}
              />
            </div>
          </div>
        )}

        <UploadModal
          isOpen={uploadOpen}
          onClose={() => setUploadOpen(false)}
          onTransactionsParsed={handleTransactionsParsed}
        />
      </main>
    </div>
  )
}
