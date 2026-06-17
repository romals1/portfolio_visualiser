import { useState, useEffect } from 'react'
import api from '../api/client'

interface Span {
  id: number
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: string
  service: string
  start_time: string
  end_time: string
  duration_ms: number
  status: string
  status_message: string | null
  attributes: Record<string, any>
  resource: Record<string, any>
}

interface Trace {
  trace_id: string
  start_time: string
  spans: Span[]
}

function durationColor(ms: number): string {
  if (ms < 100) return 'bg-emerald-400'
  if (ms < 1000) return 'bg-amber-400'
  return 'bg-red-400'
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function SpanBar({ span, traceStart, traceDuration, depth, maxNameLen }: {
  span: Span
  traceStart: number
  traceDuration: number
  depth: number
  maxNameLen: number
}) {
  const [expanded, setExpanded] = useState(false)
  const offset = traceDuration > 0 ? ((new Date(span.start_time).getTime() - traceStart) / traceDuration) * 100 : 0
  const width = traceDuration > 0 ? Math.max((span.duration_ms / traceDuration) * 100, 0.5) : 100

  return (
    <>
      <div className="flex items-center gap-2 text-xs group hover:bg-gray-50 dark:hover:bg-gray-900 py-0.5 px-1 rounded">
        <span
          className="text-gray-400 dark:text-gray-600 font-mono flex-shrink-0 truncate"
          style={{ paddingLeft: `${depth * 20}px`, minWidth: `${Math.min(maxNameLen * 7.5, 200) + depth * 20}px`, maxWidth: '300px' }}
        >
          {span.name}
        </span>
        <span className="text-gray-400 dark:text-gray-600 flex-shrink-0 w-16 text-right font-mono">
          {formatMs(span.duration_ms)}
        </span>
        <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded-sm relative min-w-[60px]">
          <div
            className={`absolute top-0 h-full rounded-sm cursor-pointer ${durationColor(span.duration_ms)}`}
            style={{ left: `${offset}%`, width: `${width}%`, minWidth: '4px' }}
            onClick={() => setExpanded(!expanded)}
            title={`${span.name}: ${formatMs(span.duration_ms)}`}
          />
        </div>
        <span className="text-gray-400 dark:text-gray-600 flex-shrink-0 w-10 text-right">
          {span.service.slice(0, 3)}
        </span>
        {span.status === 'ERROR' && (
          <span className="text-red-500 font-bold flex-shrink-0" title={span.status_message || ''}>!</span>
        )}
      </div>
      {expanded && (
        <div
          className="mb-2 p-2 bg-gray-50 dark:bg-gray-900 rounded text-xs font-mono text-gray-600 dark:text-gray-400 overflow-x-auto"
          style={{ marginLeft: `${depth * 20 + 20}px` }}
        >
          <pre>{JSON.stringify(span.attributes, null, 2)}</pre>
        </div>
      )}
    </>
  )
}

function Waterfall({ trace, onBack }: { trace: Trace; onBack: () => void }) {
  const spans = trace.spans
  const traceStart = new Date(spans[0]?.start_time || trace.start_time).getTime()
  const traceEnd = Math.max(...spans.map(s => new Date(s.end_time).getTime()))
  const traceDuration = traceEnd - traceStart
  const maxNameLen = Math.max(...spans.map(s => s.name.length))

  const depthMap = new Map<string, number>()
  const spanMap = new Map<string, Span>()
  for (const s of spans) {
    spanMap.set(s.span_id, s)
  }
  function getDepth(spanId: string): number {
    if (depthMap.has(spanId)) return depthMap.get(spanId)!
    const span = spanMap.get(spanId)
    if (!span || !span.parent_span_id || !spanMap.has(span.parent_span_id)) {
      depthMap.set(spanId, 0)
      return 0
    }
    const d = getDepth(span.parent_span_id) + 1
    depthMap.set(spanId, d)
    return d
  }
  for (const s of spans) getDepth(s.span_id)

  const totalDuration = traceDuration > 0 ? formatMs(traceDuration) : '<1ms'

  return (
    <div className="space-y-3">
      <button
        onClick={onBack}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        &larr; Back to list
      </button>
      <div className="text-xs text-gray-500 dark:text-gray-400 space-x-4">
        <span>Trace: {trace.trace_id.slice(0, 16)}&hellip;</span>
        <span>{spans.length} spans</span>
        <span>{totalDuration} total</span>
      </div>
      <div className="space-y-0.5">
        {spans.map((span) => (
          <SpanBar
            key={span.id}
            span={span}
            traceStart={traceStart}
            traceDuration={traceDuration}
            depth={depthMap.get(span.span_id) || 0}
            maxNameLen={maxNameLen}
          />
        ))}
      </div>
    </div>
  )
}

export default function TraceViewer() {
  const [traces, setTraces] = useState<Trace[]>([])
  const [selectedTrace, setSelectedTrace] = useState<Trace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTraces = async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await api.get('/api/traces', {
        params: { limit: 50, since_minutes: 60 },
      })
      setTraces(resp.data.traces || [])
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Failed to fetch traces')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTraces()
  }, [])

  if (selectedTrace) {
    return <Waterfall trace={selectedTrace} onBack={() => setSelectedTrace(null)} />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-600 dark:text-gray-400">
          Recent Traces (last 60 min)
        </h3>
        <button
          onClick={fetchTraces}
          disabled={loading}
          className="px-3 py-1 text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-colors disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="p-4 text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950 rounded-lg">
          {error}
        </div>
      )}

      {!error && !loading && traces.length === 0 && (
        <div className="py-12 text-center text-sm text-gray-400 dark:text-gray-600">
          No traces recorded yet. Use the app and traces will appear here.
        </div>
      )}

      {traces.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-4 text-xs text-gray-400 dark:text-gray-600 px-2 py-1 border-b border-gray-100 dark:border-gray-800">
            <span className="w-40">Time</span>
            <span className="w-20 text-right">Spans</span>
            <span className="w-20 text-right">Duration</span>
            <span>Slowest span</span>
          </div>
          {traces.map((trace) => {
            const maxDuration = Math.max(...trace.spans.map(s => s.duration_ms))
            const slowest = trace.spans.find(s => s.duration_ms === maxDuration)
            return (
              <div
                key={trace.trace_id}
                onClick={() => setSelectedTrace(trace)}
                className="flex items-center gap-4 text-xs px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer transition-colors"
              >
                <span className="w-40 font-mono text-gray-600 dark:text-gray-400">
                  {new Date(trace.start_time).toLocaleTimeString()}
                </span>
                <span className="w-20 text-right text-gray-600 dark:text-gray-400">
                  {trace.spans.length}
                </span>
                <span className="w-20 text-right font-mono text-gray-700 dark:text-gray-300">
                  {formatMs(maxDuration)}
                </span>
                <span className="text-gray-500 dark:text-gray-500 truncate">
                  {slowest?.name || '—'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
