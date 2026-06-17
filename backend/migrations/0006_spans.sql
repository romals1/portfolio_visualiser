-- Distributed tracing spans table.
-- No RLS: spans are operational telemetry, not user data.
create table if not exists spans (
  id              bigserial primary key,
  trace_id        text not null,
  span_id         text not null,
  parent_span_id  text,
  name            text not null,
  kind            text not null default 'INTERNAL',
  service         text not null,
  start_time      timestamptz not null,
  end_time        timestamptz not null,
  duration_ms     double precision not null,
  status          text not null default 'OK',
  status_message  text,
  attributes      jsonb default '{}',
  resource        jsonb default '{}'
);

create index if not exists idx_spans_trace_id on spans (trace_id);
create index if not exists idx_spans_start_time on spans (start_time desc);
create index if not exists idx_spans_name on spans (name);
