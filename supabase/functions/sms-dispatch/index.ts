// Sends queued recipient SMS (tracking links, PINs, status updates) through Africa's Talking.
// Run every minute from Supabase cron with header x-cron-secret. Only active when the app setting
// sms_mode is "live"; otherwise messages stay "simulated" and appear in the ops SMS outbox.
import { env, json, rpcOf, serviceClient } from '../_shared/http.ts';
import { safeEqual } from '../_shared/payments/signature.mjs';
import { sendSms } from '../_shared/africastalking.mjs';

Deno.serve(async (req) => {
  if (!env.CRON_SECRET || !safeEqual(req.headers.get('x-cron-secret') || '', env.CRON_SECRET)) return json(401, { error: 'unauthorised' });
  const rpc = rpcOf(serviceClient());
  const batch = (await rpc('sms_queue', { p_limit: 50 })) || [];
  let sent = 0, failed = 0;
  for (const m of batch) {
    try { const r = await sendSms(env, m.phone, m.body); await rpc('sms_mark', { p_id: m.id, p_ok: true, p_ref: r.messageId }); sent++; }
    catch (e) { await rpc('sms_mark', { p_id: m.id, p_ok: false, p_ref: (e as Error).message.slice(0, 120) }); failed++; }
  }
  return json(200, { sent, failed });
});
