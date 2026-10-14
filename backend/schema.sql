-- PostgreSQL schema for Mark's Savanna Stock.
-- KSh values use integer minor units (whole shillings) to avoid floating point errors.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('buyer', 'seller', 'admin');
CREATE TYPE listing_status AS ENUM ('draft', 'pending_review', 'published', 'reserved', 'sold', 'archived');
CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed');
CREATE TYPE order_status AS ENUM ('pending_payment', 'paid', 'confirmed', 'completed', 'cancelled');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone_e164 TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'buyer',
  preferred_language TEXT NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'sw')),
  trusted_trader BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE livestock_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES users(id),
  species TEXT NOT NULL, -- e.g. cattle, goat, sheep, camel, donkey
  breed TEXT,
  title JSONB NOT NULL, -- {"en":"Healthy Maasai goat", "sw":"Mbuzi mwenye afya"}
  description JSONB NOT NULL DEFAULT '{}'::jsonb,
  age_months INTEGER CHECK (age_months IS NULL OR age_months >= 0),
  estimated_weight_kg NUMERIC(7,2) CHECK (estimated_weight_kg IS NULL OR estimated_weight_kg > 0),
  price_kes BIGINT NOT NULL CHECK (price_kes >= 0),
  county TEXT NOT NULL,
  sub_county TEXT NOT NULL,
  vaccination_status TEXT NOT NULL DEFAULT 'unknown',
  veterinary_notes TEXT,
  vet_verified BOOLEAN NOT NULL DEFAULT FALSE,
  images JSONB NOT NULL DEFAULT '[]'::jsonb, -- ordered array of image URLs/metadata
  status listing_status NOT NULL DEFAULT 'pending_review',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(images) = 'array'),
  CHECK (jsonb_typeof(title) = 'object'),
  CHECK (jsonb_typeof(description) = 'object')
);
CREATE INDEX livestock_browse_idx ON livestock_listings (status, species, county, sub_county, price_kes);
CREATE INDEX livestock_seller_idx ON livestock_listings (seller_id, created_at DESC);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id UUID NOT NULL REFERENCES users(id),
  listing_id UUID NOT NULL REFERENCES livestock_listings(id),
  amount_kes BIGINT NOT NULL CHECK (amount_kes >= 0),
  status order_status NOT NULL DEFAULT 'pending_payment',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);

CREATE TABLE mpesa_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL DEFAULT 'mpesa',
  checkout_request_id TEXT UNIQUE,
  merchant_request_id TEXT,
  transaction_id TEXT UNIQUE, -- M-Pesa receipt/transaction ID, when completed
  phone_number TEXT NOT NULL,
  amount_kes BIGINT NOT NULL CHECK (amount_kes > 0),
  status payment_status NOT NULL DEFAULT 'pending',
  result_code TEXT,
  result_description TEXT,
  raw_callback JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX mpesa_payment_order_idx ON mpesa_payments (order_id, created_at DESC);

-- C2B receipts can arrive with an unknown account reference. Keep the original
-- receipt even when staff need to reconcile it manually to an order.
CREATE TABLE c2b_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id TEXT NOT NULL UNIQUE,
  bill_reference TEXT NOT NULL,
  phone_number TEXT,
  amount_kes BIGINT NOT NULL CHECK (amount_kes >= 0),
  matched_order_id UUID REFERENCES orders(id),
  raw_callback JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX c2b_receipts_reference_idx ON c2b_receipts (bill_reference, received_at DESC);

-- Keep updated_at current on data updates.
CREATE FUNCTION set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER listings_updated_at BEFORE UPDATE ON livestock_listings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON mpesa_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
