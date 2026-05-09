create table if not exists user_transactions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  transactions jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table user_transactions enable row level security;

create policy "user_transactions_owner" on user_transactions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
