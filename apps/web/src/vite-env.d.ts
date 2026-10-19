/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://abcdefgh.supabase.co */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon (public) key. Safe to ship to the browser; it can only sign people in. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Domain used to turn a username into the email Supabase Auth wants. Must match STAFF_EMAIL_DOMAIN. */
  readonly VITE_STAFF_EMAIL_DOMAIN?: string;
}

interface ImportMeta { readonly env: ImportMetaEnv; }
