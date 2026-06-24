ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'coffee',
  ADD COLUMN IF NOT EXISTS is_refurbished boolean NOT NULL DEFAULT false;

ALTER TABLE public.alerts
  ADD COLUMN IF NOT EXISTS category text;