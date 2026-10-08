import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://olywhyaozjlkjrnsdydg.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_ILVifxDQ3V9lj8W8H9WBpw_a5solIfb';

// Client for Supabase Authentication (stores user session & tokens)
export const supabase = createClient(supabaseUrl, supabaseKey);

// Public data client that ALWAYS uses the anon/public role (never blocked by user JWT RLS)
export const publicSupabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});