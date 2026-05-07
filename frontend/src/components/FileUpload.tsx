import { useRef, useState } from 'react'
import api from '../api/client'
import { Transaction } from '../types'

interface Props {
  onTransactionsParsed: (txns: Transaction[]) => void
  onClear: () => void
}

export default function FileUpload({ onTransactionsParsed, onClear }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileNames, setFileNames] = useState<string[]>([])

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
      setFileNames((prev: string[]) => [...new Set([...prev, ...files.map((f: File) => f.name)])])
      onTransactionsParsed(resp.data.transactions as Transaction[])
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

  const handleClear = () => {
    setFileNames([])
    onClear()
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

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-medium">Upload transactions</h2>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
          dragging ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 hover:border-gray-500'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          multiple
          className="hidden"
          onChange={handleChange}
        />
        {loading ? (
          <p className="text-gray-400">Parsing files…</p>
        ) : (
          <>
            <p className="text-gray-300">Drop CSV files here or click to browse</p>
            <p className="text-sm text-gray-500 mt-1">
              Supported: Superhero (AUS/US) · Interactive Brokers · Manual
            </p>
          </>
        )}
      </div>

      {fileNames.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">Loaded: {fileNames.join(', ')}</p>
          <button
            onClick={handleClear}
            className="text-xs text-gray-500 hover:text-red-400 transition-colors"
          >
            Clear all
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )
}
