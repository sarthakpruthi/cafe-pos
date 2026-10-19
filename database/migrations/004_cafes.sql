-- Cafes (shops). One app can host several cafes. Staff belong to exactly one cafe, and because
-- the sign-in address is qualified by the cafe's own domain, two cafes may use the same username.

CREATE TABLE cafes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  slug VARCHAR(60) NOT NULL UNIQUE,
  -- The domain used to turn a staff username into the address Supabase Auth sees. Each cafe gets
  -- its own (e.g. blue-bottle.cafe.local) so "manager" can exist in more than one cafe.
  email_domain VARCHAR(160) NOT NULL,
  -- Exactly one cafe is the "default": everything that existed before cafes belong to it.
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pre-existing cafe. Its name and sign-in domain are refreshed from the settings
-- (CAFE_NAME / STAFF_EMAIL_DOMAIN) whenever the server starts, so existing logins keep working.
INSERT INTO cafes (name, slug, email_domain, is_default) VALUES ('My Cafe', 'main', 'cafe.local', true);

ALTER TABLE users ADD COLUMN cafe_id UUID REFERENCES cafes(id);
UPDATE users SET cafe_id = (SELECT id FROM cafes WHERE is_default) WHERE cafe_id IS NULL;
ALTER TABLE users ALTER COLUMN cafe_id SET NOT NULL;

-- Usernames are unique within a cafe, not across the whole app.
DROP INDEX IF EXISTS users_username_lower;
CREATE UNIQUE INDEX users_cafe_username_lower ON users (cafe_id, lower(username));
