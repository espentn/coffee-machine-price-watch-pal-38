ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS drink_count integer,
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS product_url text;