-- SQLite schema: single-file DDL for local development.
-- Creates all tables needed by the app in one shot.
-- Postgres migrations under backend/migrations/ are used in production.

-- Price cache: per-symbol daily close prices
CREATE TABLE IF NOT EXISTS ticker_prices (
    yahoo_symbol TEXT NOT NULL,
    price_date   TEXT NOT NULL,
    close_price  REAL NOT NULL,
    fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (yahoo_symbol, price_date)
);

-- Dividend cache: per-symbol ex-div date amounts
CREATE TABLE IF NOT EXISTS ticker_dividends (
    yahoo_symbol TEXT NOT NULL,
    ex_date      TEXT NOT NULL,
    amount       REAL NOT NULL,
    fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (yahoo_symbol, ex_date)
);

-- Fetch-range tracking: covers already-fetched date windows
CREATE TABLE IF NOT EXISTS ticker_fetch_ranges (
    yahoo_symbol TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('price', 'dividend')),
    range_start  TEXT NOT NULL,
    range_end    TEXT NOT NULL,
    fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (yahoo_symbol, kind, range_start)
);

-- Distributed tracing spans
CREATE TABLE IF NOT EXISTS spans (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id        TEXT NOT NULL,
    span_id         TEXT NOT NULL,
    parent_span_id  TEXT,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'INTERNAL',
    service         TEXT NOT NULL,
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL,
    duration_ms     REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'OK',
    status_message  TEXT,
    attributes      TEXT DEFAULT '{}',
    resource        TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS spans_trace_id_idx ON spans (trace_id);
CREATE INDEX IF NOT EXISTS spans_start_time_idx ON spans (start_time DESC);
CREATE INDEX IF NOT EXISTS spans_name_idx ON spans (name);

-- Indexes for price cache queries
CREATE INDEX IF NOT EXISTS ticker_prices_symbol_date_idx ON ticker_prices (yahoo_symbol, price_date);
CREATE INDEX IF NOT EXISTS ticker_dividends_symbol_date_idx ON ticker_dividends (yahoo_symbol, ex_date);
CREATE INDEX IF NOT EXISTS ticker_fetch_ranges_lookup_idx ON ticker_fetch_ranges (yahoo_symbol, kind, range_start, range_end);
