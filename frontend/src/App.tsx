import { useState, useEffect } from 'react'
import Auth from './components/Auth'
import FileUpload from './components/FileUpload'
import TransactionTable from './components/TransactionTable'
import ChartArea from './components/ChartArea'
import { Transaction, ComputeResult } from './types'
import api from './api/client'
import supabase from './api/supabase'

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'))
  const [userEmail, setUserEmail] = useState<string | null>(() => localStorage.getItem('user_email'))
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [computeResult, setComputeResult] = useState<ComputeResult | null>(null)
  const [isComputing, setIsComputing] = useState(false)
  const [computeError, setComputeError] = useState<string | null>(null)

  const handleLogin = (tok: string, email: string) => {
    localStorage.setItem('auth_token', tok)
    localStorage.setItem('user_email', email)
    setToken(tok)
    setUserEmail(email)
  }

  const handleLogout = async () => {
    try { await api.post('/api/auth/logout') } catch { /* ignore */ }
    localStorage.removeItem('auth_token')
    localStorage.removeItem('user_email')
    setToken(null)
    setUserEmail(null)
    setTransactions([])
    setComputeResult(null)
  }

  const handleTransactionsParsed = (txns: Transaction[]) => {
    setTransactions(txns)
    setComputeResult(null)
    setComputeError(null)
  }

  const handleCompute = async (benchmarkTickers: string[]) => {
    if (transactions.length === 0) return
    setIsComputing(true)
    setComputeError(null)
    try {
      const resp = await api.post('/api/portfolio/compute', {
        transactions,
        benchmark_tickers: benchmarkTickers,
      })
      setComputeResult(resp.data as ComputeResult)
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

  useEffect(() => {
    if (!supabase) return

    const checkSession = async () => {
      const { data } = await supabase!.auth.getSession()
      if (data.session?.user) {
        const userEmail = data.session.user.email || ''
        const accessToken = data.session.access_token
        handleLogin(accessToken, userEmail)
      }
    }

    checkSession()

    const {
      data: { subscription },
    } = supabase!.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        const userEmail = session.user.email || ''
        const accessToken = session.access_token
        handleLogin(accessToken, userEmail)
      }
    })

    return () => {
      subscription?.unsubscribe()
    }
  }, [])

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
        <FileUpload onTransactionsParsed={handleTransactionsParsed} />

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
