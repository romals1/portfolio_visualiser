import { useEffect, useRef, useState } from 'react'
import api from '../api/client'
import { Transaction } from '../types'
import Spinner from './Spinner'

interface Props {
  isOpen: boolean
  onClose: () => void
  onTransactionsParsed: (txns: Transaction[]) => void
}

const EXCHANGE_OPTIONS = ['auto', 'ASX', 'US'] as const
const CURRENCY_OPTIONS = ['auto', 'AUD', 'USD'] as const

type ExchangeOpt = (typeof EXCHANGE_OPTIONS)[number]
type CurrencyOpt = (typeof CURRENCY_OPTIONS)[number]

export default function UploadModal({ isOpen, onClose, onTransactionsParsed }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [portfolioOverride, setPortfolioOverride] = useState('')
  const [exchangeOverride, setExchangeOverride] = useState<ExchangeOpt>('auto')
  const [currencyOverride, setCurrencyOverride] = useState<CurrencyOpt>('auto')

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  const applyDefaults = (txns: Transaction[]): Transaction[] =>
    txns.map((t) => {
      const next = { ...t }
      if (portfolioOverride.trim()) next.portfolio = portfolioOverride.trim()
      if (exchangeOverride !== 'auto') {
        next.exchange = exchangeOverride
        if (currencyOverride === 'auto') {
          next.currency = exchangeOverride === 'ASX' ? 'AUD' : 'USD'
        }
      }
      if (currencyOverride !== 'auto') next.currency = currencyOverride
      return next
    })

  const upload = async (files: File[]) => {
    if (!files.length) return
    setLoading(true)
    setError(null)
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    try {
      const resp = await api.post('/api/transactions/parse', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const txns = applyDefaults(resp.data.transactions as Transaction[])
      onTransactionsParsed(txns)
      onClose()
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } }; message?: string })
          ?.response?.data?.detail ??
        (err as { message?: string })?.message ??
        'Upload failed'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.name.endsWith('.csv'))
    upload(files)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    upload(files)
    e.target.value = ''
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-gray-900 border border-gray-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <h2 className="text-base font-medium text-gray-100">Upload transactions</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-lg leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              dragging ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 hover:border-gray-500'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv,text/plain,application/vnd.ms-excel,application/csv"
              multiple
              className="hidden"
              onChange={handleChange}
            />
            {loading ? (
              <div className="flex items-center justify-center gap-2 text-gray-400">
                <Spinner size={18} />
                <span>Parsing files…</span>
              </div>
            ) : (
              <>
                <p className="text-gray-300 text-sm">Drop CSV files here or click to browse</p>
                <p className="text-xs text-gray-500 mt-1">
                  Supported: Superhero (AUS/US) · Interactive Brokers · Manual
                </p>
              </>
            )}
          </div>

          <div className="space-y-3">
            <p className="text-xs uppercase tracking-wide text-gray-500">Defaults (optional)</p>

            <div className="grid grid-cols-3 gap-3">
              <label className="text-xs text-gray-400 space-y-1">
                <span>Portfolio</span>
                <input
                  value={portfolioOverride}
                  onChange={(e) => setPortfolioOverride(e.target.value)}
                  placeholder="from filename"
                  className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                />
              </label>

              <label className="text-xs text-gray-400 space-y-1">
                <span>Market</span>
                <select
                  value={exchangeOverride}
                  onChange={(e) => setExchangeOverride(e.target.value as ExchangeOpt)}
                  className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                >
                  {EXCHANGE_OPTIONS.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-gray-400 space-y-1">
                <span>Currency</span>
                <select
                  value={currencyOverride}
                  onChange={(e) => setCurrencyOverride(e.target.value as CurrencyOpt)}
                  className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-gray-600"
                >
                  {CURRENCY_OPTIONS.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  )
}
