import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fails loudly at startup instead of silently breaking every query later.
  // eslint-disable-next-line no-console
  console.error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in ' +
    'your Supabase project values (Project Settings → API).'
  );
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

export interface Profile {
  id: string;
  email: string;
  name: string;
  role: 'validator' | 'admin' | 'auditor';
  active: boolean;
  invite_pending: boolean;
}