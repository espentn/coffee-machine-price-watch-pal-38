
CREATE TABLE public.products (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC,
  rr_price NUMERIC,
  in_stock BOOLEAN NOT NULL DEFAULT true,
  was_below_rrp BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.products TO anon, authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read products" ON public.products FOR SELECT USING (true);

CREATE TABLE public.alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL, -- 'new', 'removed', 'price_drop', 'sale_started', 'sold_out', 'back_in_stock'
  product_code TEXT,
  product_name TEXT NOT NULL,
  message TEXT NOT NULL,
  price NUMERIC,
  old_price NUMERIC,
  rr_price NUMERIC,
  discount_pct NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.alerts TO anon, authenticated;
GRANT ALL ON public.alerts TO service_role;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read alerts" ON public.alerts FOR SELECT USING (true);

CREATE INDEX alerts_created_at_idx ON public.alerts (created_at DESC);

ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
