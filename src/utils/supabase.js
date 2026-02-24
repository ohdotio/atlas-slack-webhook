'use strict';

/**
 * Supabase client singleton.
 *
 * Initialised once with the service-role key so server-side code can bypass
 * Row Level Security when needed. Import this module everywhere you need DB
 * access — Node's module cache guarantees a single shared instance.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    '[supabase] SUPABASE_URL and SUPABASE_SERVICE_KEY env vars must be set'
  );
}

/**
 * Singleton Supabase client (service role).
 * @type {import('@supabase/supabase-js').SupabaseClient}
 */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    // Service role key — never expose to clients.
    persistSession: false,
    autoRefreshToken: false,
  },
});

module.exports = supabase;
