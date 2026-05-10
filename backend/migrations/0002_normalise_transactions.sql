-- Normalise transactions: one row per transaction in user_transaction_rows.
-- Idempotent: safe to re-run.

create table if not exists user_transaction_rows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  ticker text not null,
  action text not null,
  quantity numeric not null,
  price numeric not null,
  fees numeric not null default 0,
  exchange text not null,
  portfolio text not null,
  created_at timestamptz not null default now()
);

create index if not exists user_transaction_rows_user_date_idx
  on user_transaction_rows (user_id, date, created_at);

alter table user_transaction_rows enable row level security;

do $$ begin
  create policy "user_transaction_rows_owner" on user_transaction_rows
    for all
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;
