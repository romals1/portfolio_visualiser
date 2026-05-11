-- Add a currency column to user_transaction_rows so AUD transactions can be
-- stored in their native currency. Backfill from exchange for existing rows
-- (legacy rows were converted to USD at parse time but still tagged ASX).
-- Idempotent: safe to re-run.

alter table user_transaction_rows
  add column if not exists currency text;

update user_transaction_rows
  set currency = case when exchange = 'ASX' then 'AUD' else 'USD' end
  where currency is null;

alter table user_transaction_rows
  alter column currency set not null;
