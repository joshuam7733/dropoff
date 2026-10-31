// Supabase Auth "Send SMS" hook → Africa's Talking. Sends the sign-in / phone-change OTP codes.
// Enable in Dashboard → Authentication → Hooks → Send SMS hook (HTTPS) pointing at this function, and set
// SEND_SMS_HOOK_SECRET to the hook secret shown there ("v1,whsec_..."). Deploy with --no-verify-jwt:
// the request is authenticated by the Standard Webhooks signature instead.
import { env } from '../_shared/http.ts';
import { verifyStandardWebhook } from '../_shared/payments/signature.mjs';
import { sendSms } from '../_shared/africastalking.mjs';

Deno.serve(async (req) => {
  const body = await req.text();
  if (!(await verifyStandardWebhook(env.SEND_SMS_HOOK_SECRET, req.headers, body))) {
    return new Response(JSON.stringify({ error: { http_code: 401, message: 'Invalid signature' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const { user, sms } = JSON.parse(body);
  try {
    await sendSms(env, user.phone, `Your Drop Off code is ${sms.otp}. It expires in 10 minutes. Never share it with anyone, including Drop Off staff.`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: { http_code: 500, message: 'Could not send the code. Try again.' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
