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

// Host of the Supabase project this build actually talks to. Image URLs that
// point anywhere else (e.g. a retired CMS project) render blank on a fresh
// install, so config loading prefers values that live on this host.
export const SUPABASE_HOST = supabaseUrl;
export const isAppHostValue = (value: unknown): boolean =>
  typeof value === 'string' && (
    value.includes(supabaseUrl) ||
    value.startsWith('/api/images/') ||
    value.startsWith('data:image/')
  );

// Browser code must use a publishable key. Supabase rejects secret keys from
// browsers, so the service key stays server-side only (server.cjs / Electron
// main process) and is never bundled into the renderer.
const supabaseKey = 
  cleanEnv(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) || 
  cleanEnv(import.meta.env.VITE_SUPABASE_ANON_KEY) || 
  cleanEnv(import.meta.env.VITE_SUPABASE_KEY) || 
  FALLBACK_SUPABASE_KEY;

// Cache the default instance on the window object during development to prevent HMR duplicate client warnings
export const supabase = (window as any).supabaseClient || createClient(supabaseUrl, supabaseKey);

if (import.meta.env.DEV) {
  (window as any).supabaseClient = supabase;
}

// Public data client: never attaches a user session. Staff login is local, but
// if a customer Supabase session exists in this browser the default client
// would run cloud reads as the `authenticated` role and RLS would filter out
// website feedback and reservations. This client always uses the anon role so
// local machine data stays complete.
// (Also cached to prevent HMR warnings)
export const publicSupabase = (window as any).publicSupabaseClient || createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

if (import.meta.env.DEV) {
  (window as any).publicSupabaseClient = publicSupabase;
}

