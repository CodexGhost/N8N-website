-- ============================================================
-- FlowForge — Supabase Schema
-- Paste this entire file into the Supabase SQL Editor and run it.
-- ============================================================

-- ── Products table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text UNIQUE NOT NULL,
  name                   text NOT NULL,
  description            text,
  long_description       text,
  price                  integer NOT NULL,      -- amount in cents (e.g. 2900 = $29.00)
  currency               text NOT NULL DEFAULT 'usd',
  category               text,
  node_types             text[],
  file_path              text NOT NULL,         -- relative path to the .json workflow file
  stripe_product_id      text,
  stripe_price_id        text,
  stripe_payment_link_id text,
  stripe_payment_link    text,
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Row Level Security: anyone can read active products
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_active_products"
  ON products
  FOR SELECT
  USING (active = true);

-- ── Purchases table ───────────────────────────────────────────────────────────
-- Written only by the server (service role key). Never accessible to browsers.
CREATE TABLE IF NOT EXISTS purchases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   text UNIQUE NOT NULL,   -- Stripe checkout session ID
  product_slug text NOT NULL,
  email        text,
  amount_paid  integer,                -- cents, from Stripe session
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Row Level Security: no public access (service role bypasses RLS)
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT policy = only service_role can access

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS products_slug_idx    ON products (slug);
CREATE INDEX IF NOT EXISTS products_active_idx  ON products (active);
CREATE INDEX IF NOT EXISTS purchases_session_idx ON purchases (session_id);
CREATE INDEX IF NOT EXISTS purchases_slug_idx   ON purchases (product_slug);
