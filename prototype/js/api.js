/* Drop Off — backend connection: Supabase client, session, snapshot loading, realtime, storage and services.
   Configuration comes from config.js (window.DO_CONFIG), generated from environment variables. */
(function () {
  const D = window.DO, S = D.store;
  const CFG = window.DO_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const slot = (params.get('slot') || '').replace(/[^a-z0-9-]/gi, '');
  const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
  // On-device builds (Android APKs) route every Supabase request to the backend running in this page.
  const local = !!(CFG.local && window.DO_LOCAL);
  const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { storageKey: 'dropoff-auth' + (slot ? '-' + slot : ''), persistSession: true, autoRefreshToken: true, detectSessionInUrl: !local, flowType: 'implicit' },
    global: local ? { fetch: window.DO_LOCAL.fetch } : undefined
  }) : null;

  const A = (D.api = { sb, configured, local, config: CFG, slot, session: null, recovery: false, ready: false, loadError: null, online: navigator.onLine, realtime: 'off' });
  // on-device helpers: the demo SMS inbox and the sandbox "customer phone"
  A.localInbox = async () => (local ? (await window.DO_LOCAL.fetch(CFG.supabaseUrl + '/dev/inbox.json')).json() : []);
  A.localCode = async (phone) => { const want = A.e164(phone); const m = (await A.localInbox()).find((x) => x.kind === 'sms' && x.to === want); const c = m && /(\d{6})/.exec(m.subject); return c ? c[1] : null; };
  A.sandboxDecide = async (ref, approve) => {
    const r = await (local ? window.DO_LOCAL.fetch : fetch)(CFG.supabaseUrl + '/functions/v1/payments-sandbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref, decision: approve ? 'approve' : 'decline' }) });
    await A.refresh();
    return r.json();
  };
  // URLs served by the on-device backend can't be loaded by <img>; turn them into blob: URLs
  A.localMedia = async (url) => {
    if (!local || !url || !url.startsWith(CFG.supabaseUrl)) return url;
    const r = await window.DO_LOCAL.fetch(url);
    return r.ok ? URL.createObjectURL(await r.blob()) : null;
  };

  function friendly(err) {
    const m = (err && (err.message || err.error_description || err.msg)) || '';
    if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(m)) return "Couldn't reach Drop Off. Check your connection and try again.";
    if (/JWT expired|invalid JWT|Please sign in again/i.test(m)) return 'Your session expired. Sign in again.';
    if (/permission denied/i.test(m)) return "You don't have access to do that.";
    if (/Invalid login credentials/i.test(m)) return 'That e-mail and password don\'t match an account.';
    if (/User already registered/i.test(m)) return 'An account with this e-mail already exists. Sign in instead.';
    if (/Database error saving new user/i.test(m)) return "We couldn't create the account. Check the details (for example a plate that is already registered) and try again.";
    if (/rate limit/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    if (/you can only request this after (\d+) seconds/i.test(m)) return 'Wait ' + /after (\d+) seconds/i.exec(m)[1] + ' seconds before asking for another code.';
    if (/Token has expired or is invalid|otp_expired/i.test(m)) return 'That code is wrong or has expired. Check the SMS or ask for a new code.';
    if (/Too many attempts/i.test(m)) return 'Too many wrong codes. Ask for a new code.';
    if (/phone number has already been registered|phone_exists/i.test(m)) return 'That number is already on another Drop Off account. Sign in with it instead.';
    if (/Invalid phone number format/i.test(m)) return 'Enter a Ugandan mobile number, e.g. 0772 418 905.';
    if (/Unsupported provider|provider is not enabled/i.test(m)) return 'Google sign-in is not switched on for this project yet. Use your phone number.';
    return m || 'Something went wrong. Try again.';
  }
  A.friendly = friendly;

  A.call = async (fn, args) => {
    if (!sb) throw new D.UserError('The app is not connected to a backend yet. Add the Supabase settings to config.js.');
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) throw new D.UserError(friendly(error));
    if (data && typeof data === 'object' && data.ok === false) throw new D.UserError(data.error || 'That did not work. Try again.');
    return data;
  };

  /* ---------------- snapshot loading ---------------- */
  let inflight = null, again = false, soonTimer = null;
  A.refresh = async () => {
    if (!sb || !A.session) return;
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      try {
        const { data, error } = await sb.rpc('app_state');
        if (error) throw error;
        A.loadError = null;
        S.load(data);
      } catch (e) {
        A.loadError = friendly(e);
        S.emit('change');
      } finally { inflight = null; }
      if (again) { again = false; await A.refresh(); }
    })();
    return inflight;
  };
  A.refreshSoon = () => { clearTimeout(soonTimer); soonTimer = setTimeout(A.refresh, 250); };

  /* ---------------- realtime (with a polling safety net) ---------------- */
  let channel = null, poll = null;
  const TABLES = ['deliveries', 'delivery_events', 'delivery_messages', 'notifications', 'rider_locations', 'riders', 'wallet_transactions', 'payments',
    'support_tickets', 'verification_requests', 'proof_of_delivery', 'vendors', 'pricing_rules', 'vehicle_classes', 'service_areas'];
  function startLive() {
    stopLive();
    if (local) {
      // everything happens on this device: refresh after each action (store.js) plus a light poll for timers
      A.realtime = 'live';
      poll = setInterval(() => { if (document.visibilityState === 'visible') A.refresh(); }, 6000);
      return;
    }
    channel = sb.channel('dropoff-' + A.session.user.id);
    TABLES.forEach((t) => channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, A.refreshSoon));
    channel.subscribe((status) => { A.realtime = status === 'SUBSCRIBED' ? 'live' : 'polling'; if (status === 'SUBSCRIBED') A.refreshSoon(); });
    poll = setInterval(() => { if (document.visibilityState === 'visible') A.refresh(); }, A.realtime === 'live' ? 30000 : 8000);
  }
  function stopLive() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearInterval(poll); poll = null; A.realtime = 'off';
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') A.refreshSoon(); });
  window.addEventListener('online', () => { A.online = true; A.refreshSoon(); S.emit('change'); });
  window.addEventListener('offline', () => { A.online = false; S.emit('change'); });

  /* ---------------- session ---------------- */
  async function onSession(session) {
    const changed = (A.session && A.session.user.id) !== (session && session.user.id);
    A.session = session || null;
    if (!session) { stopLive(); D.loc && D.loc.stop(); S.load(null); if (D.publicRef) { D.PLACES = D.publicRef.places; D.SIZES = D.publicRef.sizes; } A.loadPublic().catch(() => {}); return; }
    if (changed || !S.state) { await A.refresh(); startLive(); }
  }
  A.init = async () => {
    if (!sb) { A.ready = true; return; }
    if (local) {
      try { await window.DO_LOCAL.ready; }
      catch (e) { A.loadError = "The app's on-device database couldn't start. Close the app and open it again."; A.ready = true; S.emit('change'); return; }
    }
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') { A.recovery = true; S.emit('change'); }
      if (event === 'SIGNED_OUT') { onSession(null); return; }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') setTimeout(() => onSession(session), 0);
    });
    const hashErr = /error_description=([^&]+)/.exec(location.hash);
    if (hashErr) A.linkError = decodeURIComponent(hashErr[1].replace(/\+/g, ' '));
    const { data } = await sb.auth.getSession();
    await onSession(data.session);
    A.ready = true;
    S.emit('change');
  };
  A.signIn = async (email, password) => {
    const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw new D.UserError(friendly(error));
    await onSession(data.session);
    return data;
  };
  // meta.role is a request only: the database accepts vendor, rider or recipient and never ops.
  A.signUp = async (email, password, meta) => {
    const { data, error } = await sb.auth.signUp({ email: email.trim(), password, options: { data: meta, emailRedirectTo: location.origin + location.pathname } });
    if (error) throw new D.UserError(friendly(error));
    if (data.session) await onSession(data.session);
    return { needsConfirmation: !data.session };
  };
  A.signOut = async () => { await sb.auth.signOut(); await onSession(null); };
  // "+256 772 418 905" / "0772418905" → "+256772418905"
  A.e164 = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('256')) d = d.slice(3); if (d.startsWith('0')) d = d.slice(1); return '+256' + d; };
  // Phone sign-in: Supabase Auth sends a one-time code by SMS (Africa's Talking through the Send SMS hook; the dev inbox locally).
  A.sendPhoneCode = async (phone, meta) => {
    const { error } = await sb.auth.signInWithOtp({ phone: A.e164(phone), options: { data: meta || {}, channel: 'sms' } });
    if (error) throw new D.UserError(friendly(error));
  };
  A.verifyPhoneCode = async (phone, code, type) => {
    const { data, error } = await sb.auth.verifyOtp({ phone: A.e164(phone), token: String(code || '').trim(), type: type || 'sms' });
    if (error) throw new D.UserError(friendly(error));
    if (data.session) await onSession(data.session);
    await A.refresh();
    return data;
  };
  // Proves ownership of a (new) number for an account that signed up with e-mail or Google.
  A.changePhone = async (phone) => {
    const { error } = await sb.auth.updateUser({ phone: A.e164(phone) });
    if (error) throw new D.UserError(friendly(error));
  };
  A.signInWithGoogle = async () => {
    // the OAuth round trip drops the #hash, so remember whether this was the rider or business entrance
    try { sessionStorage.setItem('dropoff-aud', D.authAudience ? D.authAudience() : 'vendor'); } catch (e) { /* private mode */ }
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname + location.search } });
    if (error) throw new D.UserError(friendly(error));
  };
  // Edge Functions (payments). Returns the JSON body; 4xx answers carry { ok:false, error } and are returned too.
  A.fn = async (name, body) => {
    if (!sb) throw new D.UserError('The app is not connected to a backend yet.');
    const { data, error } = await sb.functions.invoke(name, { body });
    if (!error) return data;
    let j = null;
    try { j = error.context && (await error.context.json()); } catch (e) { /* not JSON */ }
    if (j) return j;
    throw new D.UserError(friendly(error));
  };
  A.resetPassword = async (email) => {
    const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + location.pathname + location.search });
    if (error) throw new D.UserError(friendly(error));
  };
  A.updatePassword = async (password) => {
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw new D.UserError(friendly(error));
    A.recovery = false;
    history.replaceState(null, '', location.pathname + location.search);
  };

  /* ---------------- storage: private buckets, signed URLs ---------------- */
  A.dataUrlToBlob = (url) => { const [h, b] = url.split(','); const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: /:(.*?);/.exec(h)[1] }); };
  A.upload = async (bucket, path, blob, contentType) => {
    const body = await blob.arrayBuffer();
    const { error } = await sb.storage.from(bucket).upload(path, body, { contentType, upsert: false });
    if (error) throw new D.UserError(/row-level security|Unauthorized/i.test(error.message) ? "You can't upload this file here." : friendly(error));
    return path;
  };
  const urls = new Map();
  A.cacheLocal = (bucket, path, src) => { if (src) urls.set(bucket + '/' + path, { url: src, exp: Infinity }); };
  // Returns a usable URL for a private object, or undefined while it is being signed (null if unavailable).
  A.mediaUrl = (m) => {
    if (!m || !m.path || !sb) return null;
    const key = m.bucket + '/' + m.path;
    const hit = urls.get(key);
    if (hit && hit.exp > Date.now()) return hit.url;
    if (hit && hit.pending) return undefined;
    urls.set(key, { pending: true, exp: Infinity });
    sb.storage.from(m.bucket).createSignedUrl(m.path, 3600).then(async ({ data, error }) => {
      const u = error || !data ? null : await A.localMedia(data.signedUrl).catch(() => null);
      urls.set(key, !u ? { url: null, exp: Date.now() + 60000 } : { url: u, exp: local ? Infinity : Date.now() + 50 * 60000 });
      D.rerender && D.rerender();
    });
    return undefined;
  };

  /* ---------------- public reference data (website, before sign-in) ---------------- */
  A.publicRef = async () => {
    if (!sb) return null;
    const [cl, pr, sz, zn, pl] = await Promise.all(['vehicle_classes', 'pricing_rules', 'package_sizes', 'service_areas', 'places']
      .map((t) => sb.from(t).select('*').then((r) => r.data || [])));
    return {
      classes: cl.sort((a, b) => a.sort - b.sort).map((c) => ({ id: c.id, label: c.label, long: c.long_label, maxKg: +c.max_kg, speed: +c.speed_kmh, enabled: c.enabled })),
      pricing: Object.fromEntries(pr.map((p) => [p.class_id, { base: p.base, perKm: p.per_km, min: p.min_fare, fragile: p.fragile, express: p.express, commission: +p.commission_pct }])),
      sizes: sz.sort((a, b) => a.sort - b.sort).map((s) => ({ id: s.id, label: s.label, hint: s.hint, maxKg: +s.max_kg, best: s.best_class, eligible: s.eligible })),
      zones: zn, places: pl.map((p) => ({ id: p.id, name: p.name, area: p.area, zone: p.zone_id, x: +p.x, y: +p.y, lat: p.lat, lng: p.lng }))
    };
  };

  A.loadPublic = async () => {
    if (D.publicRef) return D.publicRef;
    const r = await A.publicRef();
    if (!r) return null;
    D.publicRef = r;
    if (!S.state) { D.PLACES = r.places; D.SIZES = r.sizes; }
    S.emit('change');
    return r;
  };

  /* ---------------- location service (device GPS; a production provider can replace this object) ---------------- */
  const L = (D.loc = { state: 'off', fix: null, error: null, watch: null, lastSent: null });
  L.start = () => {
    if (L.watch != null) return;
    if (!('geolocation' in navigator)) { L.state = 'unavailable'; S.emit('change'); return; }
    L.state = 'asking'; S.emit('change');
    L.watch = navigator.geolocation.watchPosition((pos) => {
      const c = pos.coords;
      L.fix = { lat: c.latitude, lng: c.longitude, accuracy: Math.round(c.accuracy), heading: c.heading, speed: c.speed, at: Date.now() };
      L.state = 'on'; L.error = null;
      const last = L.lastSent;
      const moved = last ? S.geo.distM(last.lat, last.lng, c.latitude, c.longitude) : Infinity;
      if (!last || moved > 25 || Date.now() - last.at > 20000) {
        L.lastSent = { ...L.fix };
        A.call('rider_update_location', { p_lat: c.latitude, p_lng: c.longitude, p_accuracy: Math.round(c.accuracy), p_heading: c.heading, p_speed: c.speed })
          .then((r) => { if (r && r.status) A.refreshSoon(); }).catch(() => {});
      }
      S.emit('change');
    }, (err) => {
      L.state = err.code === 1 ? 'denied' : 'unavailable';
      L.error = err.code === 1 ? 'Location permission is off. Turn it on so vendors and recipients can follow the delivery.' : 'No GPS signal yet.';
      if (err.code === 1) { navigator.geolocation.clearWatch(L.watch); L.watch = null; }
      S.emit('change');
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  };
  L.stop = () => { if (L.watch != null) navigator.geolocation.clearWatch(L.watch); L.watch = null; L.state = 'off'; };

  /* ---------------- payment service ---------------- */
  // Payments: the app only creates a pending payment and asks the payments-initiate Edge Function to send it.
  // Money moves when the provider confirms (payments-webhook → payment_apply_result). The provider in use is
  // recorded on each payment; 'sandbox' means no real money moves.
  D.payments = {
    sandbox: (p) => !p || p.provider === 'sandbox' || p.provider === 'simulated' || (p.simulated && p.provider !== 'internal'),
    label: 'Sandbox payments · no real money moves',
    methodLabel: (m) => ({ wallet: 'Drop Off Wallet', momo: 'MTN Mobile Money', airtel: 'Airtel Money', card: 'Card', credit: 'Business credit' }[m] || m),
    network: (phone) => { const d = String(phone || '').replace(/\D/g, '').replace(/^256/, '').replace(/^0/, ''); return /^7[6-9]/.test(d) ? 'momo' : /^7[045]/.test(d) ? 'airtel' : null; }
  };
})();
