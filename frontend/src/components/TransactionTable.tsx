import { useState } from 'react'
import { Transaction } from '../types'

interface Props {
  transactions: Transaction[]
  onChange: (txns: Transaction[]) => void
  onUpload: () => void
}

type SortDir = 'asc' | 'desc'

interface Column {
  key: keyof Transaction
  label: string
}

const ACTIONS = ['BUY', 'SELL', 'DIV']
const EXCHANGES = ['ASX', 'US']

function currencyForExchange(exchange: string): string {
  return exchange === 'ASX' ? 'AUD' : 'USD'
}

const COLUMNS: Column[] = [
  { key: 'date', label: 'Date' },
  { key: 'ticker', label: 'Ticker' },
  { key: 'action', label: 'Action' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'price', label: 'Price' },
  { key: 'fees', label: 'Fees' },
  { key: 'exchange', label: 'Exchange' },
]

export function emptyRow(): Transaction {
  return {
    date: '',
    ticker: '',
    action: 'BUY',
    quantity: 0,
    price: 0,
    fees: 0,
    exchange: 'US',
    currency: 'USD',
  }
}

function downloadCSV(txns: Transaction[]) {
  const cols: (keyof Transaction)[] = [
    'date', 'ticker', 'action', 'quantity', 'price', 'fees', 'exchange',
  ]
  const header = cols.join(',')
  const rows = txns.map((r) => cols.map((c) => r[c]).join(','))
  const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'transactions.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export default function TransactionTable({ transactions, onChange, onUpload }: Props) {
  const [sortKey, setSortKey] = useState<keyof Transaction>('date')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filters, setFilters] = useState<Partial<Record<keyof Transaction, string>>>({})

  const update = (i: number, field: keyof Transaction, value: string | number) => {
    onChange(
      transactions.map((r, idx) => {
        if (idx !== i) return r
        const next = { ...r, [field]: value }
        if (field === 'exchange') {
          next.currency = currencyForExchange(String(value))
        }
        return next
      }),
    )
  }

  const addRow = () => onChange([...transactions, emptyRow()])
  const deleteRow = (i: number) => onChange(transactions.filter((_, idx) => idx !== i))

  const toggleSort = (key: keyof Transaction) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const setFilter = (key: keyof Transaction, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }))
  }

  const indexed = transactions.map((row, originalIndex) => ({ row, originalIndex }))

  const filtered = indexed.filter(({ row }) =>
    COLUMNS.every(({ key }) => {
      const q = (filters[key] ?? '').trim().toLowerCase()
      if (!q) return true
      return String(row[key]).toLowerCase().includes(q)
    })
  )

  const sorted = [...filtered].sort((a, b) => {
    const av = a.row[sortKey]
    const bv = b.row[sortKey]
    let cmp: number
    if (typeof av === 'number' && typeof bv === 'number') {
      cmp = av - bv
    } else {
      cmp = String(av).localeCompare(String(bv))
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">Transactions ({transactions.length} rows)</h2>
        <div className="flex items-center gap-3">
          <button onClick={onUpload} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300">
            Upload CSV
          </button>
          <button onClick={() => downloadCSV(transactions)} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300">
            Download CSV
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
            <tr>
              {COLUMNS.map(({ key, label }) => {
                const arrow = sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
                return (
                  <th
                    key={key}
                    onClick={() => toggleSort(key)}
                    className="px-3 py-2 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:text-gray-900 dark:hover:text-white"
                  >
                    {label}{arrow}
                  </th>
                )
              })}
              <th className="px-3 py-2" />
            </tr>
            <tr>
              {COLUMNS.map(({ key }) => (
                <th key={key} className="px-2 pb-2">
                  <input
                    value={filters[key] ?? ''}
                    onChange={(e) => setFilter(key, e.target.value)}
                    placeholder="filter..."
                    className="w-full bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 rounded px-1 py-0.5 text-xs font-normal focus:outline-none"
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              ))}
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
            {sorted.map(({ row, originalIndex }, displayIndex) => (
              <tr
                key={originalIndex}
                className={(displayIndex % 2 === 0 ? 'bg-gray-50 dark:bg-gray-950' : 'bg-white dark:bg-gray-900') + ' hover:bg-gray-200 dark:hover:bg-gray-800'}
              >
                <td className="px-2 py-1">
                  <input
                    type="date"
                    value={row.date}
                    onChange={(e) => update(originalIndex, 'date', e.target.value)}
                    className="bg-transparent text-gray-800 dark:text-gray-200 focus:outline-none w-36"
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    value={row.ticker}
                    onChange={(e) => update(originalIndex, 'ticker', e.target.value.toUpperCase())}
                    className="bg-transparent text-gray-800 dark:text-gray-200 focus:outline-none w-20 uppercase"
                    placeholder="AAPL"
                  />
                </td>
                <td className="px-2 py-1">
                  <select
                    value={row.action}
                    onChange={(e) => update(originalIndex, 'action', e.target.value)}
                    className="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded px-1 focus:outline-none"
                  >
                    {ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1">
                  <input
                    type="number"
                    value={row.quantity}
                    onChange={(e) => update(originalIndex, 'quantity', Number(e.target.value))}
                    className="bg-transparent text-gray-800 dark:text-gray-200 focus:outline-none w-24"
                    min={0}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    type="number"
                    value={row.price}
                    onChange={(e) => update(originalIndex, 'price', Number(e.target.value))}
                    className="bg-transparent text-gray-800 dark:text-gray-200 focus:outline-none w-24"
                    min={0}
                    step="0.0001"
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    type="number"
                    value={row.fees}
                    onChange={(e) => update(originalIndex, 'fees', Number(e.target.value))}
                    className="bg-transparent text-gray-800 dark:text-gray-200 focus:outline-none w-20"
                    min={0}
                    step="0.01"
                  />
                </td>
                <td className="px-2 py-1">
                  <select
                    value={row.exchange}
                    onChange={(e) => update(originalIndex, 'exchange', e.target.value)}
                    className="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded px-1 focus:outline-none"
                  >
                    {EXCHANGES.map((ex) => (
                      <option key={ex}>{ex}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1">
                  <button
                    onClick={() => deleteRow(originalIndex)}
                    className="text-gray-400 dark:text-gray-600 hover:text-red-600 dark:hover:text-red-400 text-xs"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-3 py-2 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800">
          <button onClick={addRow} className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300">
            + Add row
          </button>
        </div>
      </div>
    </div>
  )
}
