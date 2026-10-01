import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://olywhyaozjlkjrnsdydg.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_ILVifxDQ3V9lj8W8H9WBpw_a5solIfb';

export const supabase = createClient(supabaseUrl, supabaseKey);