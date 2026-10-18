-- Supabase serves the `public` schema to the world through its REST API (PostgREST) using the
-- `anon` and `authenticated` roles. This app talks to Postgres directly as the table owner, and in
-- PostgreSQL a table owner bypasses row level security, so turning RLS on with no policies keeps
-- the app working while denying those public roles.
--
-- If you later want to read these tables with the Supabase client, remove this file and the row for
-- it in `schema_migrations`, or add the policies you need.

ALTER TABLE cafe_tables        ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_sections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations  ENABLE ROW LEVEL SECURITY;
