-- Price cache: one row per (symbol, trading day)
-- No RLS: prices are public market data, not user-specific.
create table if not exists ticker_prices (
  yahoo_symbol text not null,
  price_date   date not null,
  close_price  numeric not null,
  fetched_at   timestamptz not null default now(),
  primary key (yahoo_symbol, price_date)
);

-- Dividend cache: one row per (symbol, ex-div date)
create table if not exists ticker_dividends (
  yahoo_symbol text not null,
  ex_date      date not null,
  amount       numeric not null,
  fetched_at   timestamptz not null default now(),
  primary key (yahoo_symbol, ex_date)
);

-- Tracks date windows already fetched, so we don't re-fetch holidays/weekends
create table if not exists ticker_fetch_ranges (
  yahoo_symbol text not null,
  kind         text not null check (kind in ('price', 'dividend')),
  range_start  date not null,
  range_end    date not null,
  fetched_at   timestamptz not null default now(),
  primary key (yahoo_symbol, kind, range_start)
);

create index if not exists ticker_prices_symbol_date_idx
  on ticker_prices (yahoo_symbol, price_date);
create index if not exists ticker_dividends_symbol_date_idx
  on ticker_dividends (yahoo_symbol, ex_date);
create index if not exists ticker_fetch_ranges_lookup_idx
  on ticker_fetch_ranges (yahoo_symbol, kind, range_start, range_end);
