// frontend/src/lib/tracing.ts
import { context, trace, Span, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request'
import { registerInstrumentations } from '@opentelemetry/instrumentation'

const SERVICE_NAME = 'portfolio-frontend'

let _tracer: ReturnType<typeof trace.getTracer> | null = null

class ApiTraceExporter {
  private _endpoint: string
  private _shutdown: boolean = false

  constructor(endpoint = '/api/traces') {
    this._endpoint = endpoint
  }

  export(spans: any[], resultCallback: (result: { code: number }) => void): void {
    if (this._shutdown || spans.length === 0) {
      resultCallback({ code: 0 })
      return
    }

    const payload = {
      spans: spans.map((span) => ({
        trace_id: span._spanContext?.traceId || '',
        span_id: span._spanContext?.spanId || '',
        parent_span_id: span.parentSpanId || null,
        name: span.name || 'unnamed',
        kind: span.kind === SpanKind.SERVER ? 'SERVER'
          : span.kind === SpanKind.CLIENT ? 'CLIENT'
          : 'INTERNAL',
        service: SERVICE_NAME,
        start_time: span.startTime ? new Date(span.startTime[0] * 1000 + span.startTime[1] / 1_000_000).toISOString() : new Date().toISOString(),
        end_time: span.endTime ? new Date(span.endTime[0] * 1000 + span.endTime[1] / 1_000_000).toISOString() : new Date().toISOString(),
        duration_ms: span.duration ? span.duration[0] * 1000 + span.duration[1] / 1_000_000 : 0,
        status: span.status?.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK',
        status_message: span.status?.message || null,
        attributes: span.attributes || {},
        resource: span.resource?.attributes || {},
      })),
    }

    const body = JSON.stringify(payload)
    const sent = navigator.sendBeacon(this._endpoint, body)
    if (!sent) {
      fetch(this._endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
    }

    resultCallback({ code: 0 })
  }

  shutdown(): Promise<void> {
    this._shutdown = true
    return Promise.resolve()
  }
}

export function initFrontendTracing(): void {
  const exporter = new ApiTraceExporter('/api/traces')
  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 10,
    scheduledDelayMillis: 5000,
    maxQueueSize: 50,
  })

  const provider = new WebTracerProvider({
    spanProcessors: [processor],
  })
  provider.register()

  _tracer = trace.getTracer('portfolio-frontend', '0.1.0')

  // Auto-instrument XMLHttpRequest (covers axios)
  try {
    registerInstrumentations({
      instrumentations: [new XMLHttpRequestInstrumentation()],
    })
  } catch {
    // XHR instrumentation is best-effort
  }
}

export function getTracer() {
  if (!_tracer) {
    _tracer = trace.getTracer('portfolio-frontend', '0.1.0')
  }
  return _tracer
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string>
): Promise<T> {
  const tracer = getTracer()
  const span = tracer.startSpan(name)
  if (attributes) {
    span.setAttributes(attributes)
  }
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span))
  } catch (err: any) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) })
    throw err
  } finally {
    span.end()
  }
}
