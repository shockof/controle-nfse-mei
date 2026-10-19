-- Execute uma vez para adicionar os registros de DAS pagos e gastos do MEI
-- ao projeto Supabase já em uso. Os comprovantes não são armazenados.
create table if not exists public.payment_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('das','gasto')),
  recipient text not null check (length(trim(recipient)) > 0),
  amount numeric(14,2) not null check (amount > 0),
  payment_date date not null,
  reference_month date not null check (extract(day from reference_month) = 1),
  source text not null default 'manual' check (source in ('manual','pdf','imagem')),
  fingerprint text not null,
  created_at timestamptz not null default now(),
  unique (user_id, fingerprint)
);

create index if not exists payment_records_user_category_month_idx
  on public.payment_records(user_id, category, reference_month desc, payment_date desc);

alter table public.payment_records enable row level security;
drop policy if exists "Users manage their own payment records" on public.payment_records;
create policy "Users manage their own payment records" on public.payment_records
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.payment_records to authenticated;
