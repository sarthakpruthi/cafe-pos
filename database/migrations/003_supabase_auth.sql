-- Staff sign-in moves to Supabase Auth. Passwords are now held by Supabase (hashed with bcrypt
-- there), so the app no longer stores one. `users` stays as the profile table: its id is the
-- Supabase auth user id, which keeps every audit_logs/notifications foreign key valid.

ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
