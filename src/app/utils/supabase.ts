/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 
  import.meta.env.VITE_SUPABASE_URL || 
  'https://olywhyaozjlkjrnsdydg.supabase.co';

const supabaseKey = 
  import.meta.env.VITE_SUPABASE_SERVICE_KEY || 
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 
  import.meta.env.VITE_SUPABASE_ANON_KEY || 
  import.meta.env.VITE_SUPABASE_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9seXdoeWFvempsa2pybnNkeWRnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTg5NjAxNCwiZXhwIjoyMTA1NDcyMDE0fQ.9M87B5oO8bKLtkaH5MIpzZ1KzvhE3qr6y5GApWzStn4';

if (!supabaseKey) {
  console.error('❌ [Supabase Client Error]: No public Supabase key found in import.meta.env.');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
export const publicSupabase = supabase;
