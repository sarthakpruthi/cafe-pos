-- Cafe QR ordering: initial schema. Money is NUMERIC(12,2). Timestamps are UTC (timestamptz).

CREATE TABLE cafe_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_number VARCHAR(20) NOT NULL UNIQUE,
  display_name VARCHAR(60),
  qr_token VARCHAR(64) NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE menu_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX menu_sections_active_name ON menu_sections (lower(name)) WHERE is_active;

CREATE TABLE menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID NOT NULL REFERENCES menu_sections(id),
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  description TEXT,
  food_type VARCHAR(10) NOT NULL DEFAULT 'VEG' CHECK (food_type IN ('VEG','NON_VEG','EGG')),
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  is_available BOOLEAN NOT NULL DEFAULT true,   -- "sold out today" switch
  is_active BOOLEAN NOT NULL DEFAULT true,      -- soft delete / hidden from menu
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_section ON menu_items(section_id);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL,
  username VARCHAR(60) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(10) NOT NULL CHECK (role IN ('MANAGER','STAFF')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE table_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID NOT NULL REFERENCES cafe_tables(id),
  session_number INTEGER NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_by_user_id UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closed_by_user_id UUID REFERENCES users(id),
  close_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (table_id, session_number)
);
-- At most one OPEN session per table, enforced by the database itself.
CREATE UNIQUE INDEX one_open_session_per_table ON table_sessions (table_id) WHERE status = 'OPEN';

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES table_sessions(id),
  order_number INTEGER NOT NULL,
  source VARCHAR(12) NOT NULL CHECK (source IN ('CUSTOMER_QR','STAFF')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  customer_note TEXT,
  created_by_user_id UUID REFERENCES users(id),
  idempotency_key VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, order_number),
  UNIQUE (session_id, idempotency_key)
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  line_number INTEGER NOT NULL DEFAULT 0,
  menu_item_id UUID REFERENCES menu_items(id),
  item_name_snapshot VARCHAR(120) NOT NULL,
  food_type_snapshot VARCHAR(10) NOT NULL,
  unit_price_snapshot NUMERIC(12,2) NOT NULL CHECK (unit_price_snapshot >= 0),
  tax_rate_snapshot NUMERIC(5,2) NOT NULL CHECK (tax_rate_snapshot >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  notes TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','SERVED','REJECTED','CANCELLED')),
  rejection_reason TEXT,
  status_updated_by_user_id UUID REFERENCES users(id),
  status_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_items_order ON order_items(order_id);

CREATE SEQUENCE bill_number_seq START 1;
CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE REFERENCES table_sessions(id),
  bill_number VARCHAR(20) NOT NULL UNIQUE,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance_due NUMERIC(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(15) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','CLOSED','VOID')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  closed_by_user_id UUID REFERENCES users(id)
);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES bills(id),
  method VARCHAR(10) NOT NULL CHECK (method IN ('CASH','UPI','CARD')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status VARCHAR(10) NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','VOIDED')),
  reference_number TEXT,
  notes TEXT,
  idempotency_key VARCHAR(100),
  recorded_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id),
  void_reason TEXT,
  UNIQUE (bill_id, idempotency_key)
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  request_id VARCHAR(60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created ON audit_logs(created_at DESC);

-- Audit logs are append-only for the application.
CREATE FUNCTION audit_logs_block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_changes();

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(40) NOT NULL,
  table_id UUID REFERENCES cafe_tables(id),
  session_id UUID REFERENCES table_sessions(id),
  order_id UUID REFERENCES orders(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id),
  user_id UUID NOT NULL REFERENCES users(id),
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE app_settings (key VARCHAR(40) PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO app_settings (key, value) VALUES ('menu_version', '1');
