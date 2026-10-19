-- Execute no SQL Editor do Supabase. O RLS garante isolamento por usuário.
create extension if not exists pgcrypto;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_name text not null check (length(trim(company_name)) > 0),
  amount numeric(14,2) not null check (amount > 0),
  issue_date date not null,
  description text not null check (length(trim(description)) > 0),
  invoice_number text,
  status text not null default 'emitida' check (status in ('emitida','cancelada','substituida')),
  source text not null default 'manual' check (source in ('manual','xml','pdf')),
  fingerprint text not null,
  replaced_by uuid references public.invoices(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, fingerprint)
);
create index if not exists invoices_user_date_idx on public.invoices(user_id, issue_date desc);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  annual_limit numeric(14,2) not null default 81000 check (annual_limit >= 0),
  fiscal_year integer not null default extract(year from now())::integer check (fiscal_year between 2000 and 2100),
  alert_percent integer not null default 80 check (alert_percent between 1 and 100),
  updated_at timestamptz not null default now()
);

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

alter table public.invoices enable row level security;
alter table public.user_settings enable row level security;
alter table public.payment_records enable row level security;

drop policy if exists "Users manage their own invoices" on public.invoices;
create policy "Users manage their own invoices" on public.invoices
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own settings" on public.user_settings;
create policy "Users manage their own settings" on public.user_settings
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own payment records" on public.payment_records;
create policy "Users manage their own payment records" on public.payment_records
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.invoices to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert, update, delete on public.payment_records to authenticated;
