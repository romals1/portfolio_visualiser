-- Drop the portfolio column from user_transaction_rows.
-- The app no longer supports per-portfolio grouping; all transactions
-- contribute to a single aggregate portfolio.
-- Idempotent: safe to re-run.

alter table user_transaction_rows
  drop column if exists portfolio;
