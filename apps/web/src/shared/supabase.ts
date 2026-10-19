// Supabase Auth in the browser. Staff sign in here and the API only ever sees the resulting token.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const supabaseConfigured = Boolean(url && anonKey);
export const supabase: SupabaseClient | null = supabaseConfigured ? createClient(url, anonKey) : null;

/**
 * Staff type a username; Supabase Auth needs an email, so we derive one from the cafe's own
 * sign-in domain. The login screen picks the cafe first, so two cafes can both have a "manager".
 */
export const staffEmail = (username: string, emailDomain: string) => `${username.trim().toLowerCase()}@${emailDomain}`;
