import { useState } from 'react'
import { Transaction } from '../types'

interface Props {
  transactions: Transaction[]
  onChange: (txns: Transaction[]) => void
}

const ACTIONS = ['BUY', 'SELL', 'DIV']
const EXCHANGES = ['ASX', 'US']

function emptyRow(): Transaction {
  return {
    date: '',
    ticker: '',
    action: 'BUY',
    quantity: 0,
    price: 0,
    fees: 0,
    exchange: 'US',
    portfolio: 'manual',
  }
}

function downloadCSV(txns: Transaction[]) {
  const cols: (keyof Transaction)[] = [
    'date', 'ticker', 'action', 'quantity', 'price', 'fees', 'exchange', 'portfolio',
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

export default function TransactionTable({ transactions, onChange }: Props) {
  const [open, setOpen] = useState(false)

  const update = (i: number, field: keyof Transaction, value: string | number) => {
    onChange(transactions.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))
  }

  const addRow = () => onChange([...transactions, emptyRow()])
  const deleteRow = (i: number) => onChange(transactions.filter((_, idx) => idx !== i))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOpen(!open)}
          className="text-sm font-medium text-gray-300 hover:text-white flex items-center gap-2"
        >
          <span>{open ? '▾' : '▸'}</span>
          Transactions ({transactions.length} rows)
        </button>
        {open && (
          <button
            onClick={() => downloadCSV(transactions)}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            Download CSV
          </button>
        )}
      </div>

      {open && (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                {['Date', 'Ticker', 'Action', 'Quantity', 'Price', 'Fees', 'Exchange', 'Portfolio', ''].map(
                  (h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {transactions.map((row, i) => (
                <tr key={i} className="hover:bg-gray-900">
                  <td className="px-2 py-1">
                    <input
                      type="date"
                      value={row.date}
                      onChange={(e) => update(i, 'date', e.target.value)}
                      className="bg-transparent text-gray-200 focus:outline-none w-36"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={row.ticker}
                      onChange={(e) => update(i, 'ticker', e.target.value.toUpperCase())}
                      className="bg-transparent text-gray-200 focus:outline-none w-20 uppercase"
                      placeholder="AAPL"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <select
                      value={row.action}
                      onChange={(e) => update(i, 'action', e.target.value)}
                      className="bg-gray-800 text-gray-200 rounded px-1 focus:outline-none"
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
                      onChange={(e) => update(i, 'quantity', Number(e.target.value))}
                      className="bg-transparent text-gray-200 focus:outline-none w-24"
                      min={0}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      value={row.price}
                      onChange={(e) => update(i, 'price', Number(e.target.value))}
                      className="bg-transparent text-gray-200 focus:outline-none w-24"
                      min={0}
                      step="0.0001"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      value={row.fees}
                      onChange={(e) => update(i, 'fees', Number(e.target.value))}
                      className="bg-transparent text-gray-200 focus:outline-none w-20"
                      min={0}
                      step="0.01"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <select
                      value={row.exchange}
                      onChange={(e) => update(i, 'exchange', e.target.value)}
                      className="bg-gray-800 text-gray-200 rounded px-1 focus:outline-none"
                    >
                      {EXCHANGES.map((ex) => (
                        <option key={ex}>{ex}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={row.portfolio}
                      onChange={(e) => update(i, 'portfolio', e.target.value)}
                      className="bg-transparent text-gray-200 focus:outline-none w-28"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <button
                      onClick={() => deleteRow(i)}
                      className="text-gray-600 hover:text-red-400 text-xs"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2 bg-gray-900 border-t border-gray-800">
            <button onClick={addRow} className="text-sm text-blue-400 hover:text-blue-300">
              + Add row
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
