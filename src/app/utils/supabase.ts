/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';

const FALLBACK_SUPABASE_URL = 'https://olywhyaozjlkjrnsdydg.supabase.co';
const FALLBACK_SUPABASE_KEY = 'sb_publishable_ILVifxDQ3V9lj8W8H9WBpw_a5solIfb';

function cleanEnv(val: any): string {
  if (typeof val !== 'string') return '';
  const s = val.trim();
  if (!s || s === 'undefined' || s === 'null' || s === '""' || s === "''") return '';
  return s;
}

const supabaseUrl = 
  cleanEnv(import.meta.env.VITE_SUPABASE_URL) || 
  FALLBACK_SUPABASE_URL;

// Browser code must use a publishable key. Supabase rejects secret keys from
// browsers ("Forbidden use of secret API key in browser"), so the service key
// stays server-side only (server.cjs / Electron main process).
const supabaseKey = 
  cleanEnv(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) || 
  FALLBACK_SUPABASE_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

// Public data client: never attaches a user session, so public reads and
// reservation writes always run with the anon/public role instead of being
// filtered by the logged-in user's RLS policies.
export const publicSupabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

