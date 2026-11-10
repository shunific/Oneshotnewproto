/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';

const FALLBACK_SUPABASE_URL = 'https://olywhyaozjlkjrnsdydg.supabase.co';
const FALLBACK_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9seXdoeWFvempsa2pybnNkeWRnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTg5NjAxNCwiZXhwIjoyMTA1NDcyMDE0fQ.9M87B5oO8bKLtkaH5MIpzZ1KzvhE3qr6y5GApWzStn4';

function cleanEnv(val: any): string {
  if (typeof val !== 'string') return '';
  const s = val.trim();
  if (!s || s === 'undefined' || s === 'null' || s === '""' || s === "''") return '';
  return s;
}

const supabaseUrl = 
  cleanEnv(import.meta.env.VITE_SUPABASE_URL) || 
  FALLBACK_SUPABASE_URL;

const supabaseKey = 
  cleanEnv(import.meta.env.VITE_SUPABASE_SERVICE_KEY) || 
  cleanEnv(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) || 
  cleanEnv(import.meta.env.VITE_SUPABASE_ANON_KEY) || 
  cleanEnv(import.meta.env.VITE_SUPABASE_KEY) || 
  FALLBACK_SUPABASE_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

// Public data client: never attaches a user session. Staff login is local, but
// if a customer Supabase session exists in this browser the default client
// would run cloud reads as the `authenticated` role and RLS would filter out
// website feedback and reservations. This client always uses the anon/service
// role so local machine data stays complete.
export const publicSupabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

