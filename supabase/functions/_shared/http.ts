// Shared helpers for Drop Off Edge Functions (Deno).
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const env = Deno.env.toObject();
export const CORS = {
  'access-control-allow-origin': env.APP_ORIGIN || '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS'
};
export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// Service-role client: bypasses RLS. Only ever created inside Edge Functions.
export const serviceClient = (): SupabaseClient => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Client acting as the caller (their JWT), so database ownership checks and RLS apply.
export const userClient = (req: Request): SupabaseClient => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false }, global: { headers: { authorization: req.headers.get('authorization') || '' } }
});
export const rpcOf = (c: SupabaseClient) => async (fn: string, args: Record<string, unknown>) => {
  const { data, error } = await c.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
};
