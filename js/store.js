/* Drop Off — client store.
   S.state is a read model of the database for the signed-in user: it is replaced whenever DO.api loads a
   fresh snapshot (app_state(), already filtered by Row Level Security). Screens read S.state; every change goes
   through S.act.*, which calls a server function and then reloads. Nothing here invents deliveries, drivers,
   balances or statuses. Pricing and route maths mirror the database so a vendor sees the price they will pay. */
(function () {
  const D = window.DO;
  const MIN = 60000;

  class UserError extends Error {}
  D.UserError = UserError;
  const must = (cond, msg) => { if (!cond) throw new UserError(msg); };

  const S = (D.store = { state: null, listeners: new Set(), notifyListeners: new Set() });

  /* ---------------- formatting ---------------- */
  const F = (D.fmt = {
    ugx: (n) => 'UGX ' + Math.round(n || 0).toLocaleString('en-US'),
    num: (n) => Math.round(n || 0).toLocaleString('en-US'),
    k: (n) => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n))),
    time: (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    timeS: (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
    day: (ts) => {
      const d = new Date(ts), now = new Date();
      const sameDay = (a, b) => a.toDateString() === b.toDateString();
      if (sameDay(d, now)) return 'Today';
      const y = new Date(now); y.setDate(y.getDate() - 1);
      if (sameDay(d, y)) return 'Yesterday';
      return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
    },
    dayTime: (ts) => F.day(ts) + ', ' + F.time(ts),
    full: (ts) => new Date(ts).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + F.timeS(ts),
    ago: (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : F.day(ts); },
    mins: (m) => (m == null ? '—' : m < 1 ? 'under 1 min' : m < 60 ? Math.round(m) + ' min' : Math.floor(m / 60) + ' h ' + Math.round(m % 60) + ' min'),
    km: (m) => (m < 950 ? Math.max(50, Math.round(m / 50) * 50) + ' m' : (m / 1000).toFixed(1) + ' km'),
    phoneMask: (p) => (p || '').replace(/(\+256 \d{3}) (\d{3}) (\d{3})/, '$1 •••$3'),
    first: (name) => { const p = (name || '').split(' '); return p[0] + (p[1] ? ' ' + p[1][0] + '.' : ''); },
    initials: (name) => (name || '?').split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase(),
    since: (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  });

  /* ---------------- lookups ---------------- */
  // Before sign-in, reference data (classes, zones, pricing) comes from the public tables via DO.api.loadPublic().
  const EMPTY = { vendors: [], riders: [], deliveries: [], transactions: [], payments: [], notifications: [], tickets: [], verifications: [], audit: [], sms: [], disputes: [], settings: {}, limits: null,
    get classes() { return (D.publicRef || {}).classes || []; }, get zones() { return (D.publicRef || {}).zones || []; }, get pricing() { return (D.publicRef || {}).pricing || {}; },
    get clock() { return Date.now(); } };
  const st = () => S.state || EMPTY;
  const place = (id) => D.PLACES.find((p) => p.id === id);
  const vendor = (id) => st().vendors.find((v) => v.id === id);
  const rider = (id) => id && st().riders.find((r) => r.id === id);
  const delivery = (id) => id && st().deliveries.find((d) => d.id === id || d.uuid === id);
  const cls = (id) => st().classes.find((c) => c.id === id) || { id, label: id || '—', long: id || '—', maxKg: 0, speed: 30, enabled: false };
  const sizeOf = (id) => D.SIZES.find((s) => s.id === id);
  const zone = (id) => st().zones.find((z) => z.id === id) || { id, name: id, enabled: false };
  Object.assign(S, { place, vendor, rider, delivery, cls, sizeOf, zone });
  S.me = () => (S.state && S.state.me) || null;

  /* ---------------- distances on real coordinates (mirrors public._dist_m / _route_km10) ----------------
     Road distance is estimated as straight-line metres × 1.3 until a routing provider is connected.
     Points are { lat, lng }; lengths are metres. */
  const distM = (aLat, aLng, bLat, bLng) => { const R = 6371000, r = Math.PI / 180; const x = Math.sin(((bLat - aLat) * r) / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLng - aLng) * r) / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(x))); };
  const has = (p) => p && p.lat != null && p.lng != null;
  const km10 = (a, b) => (has(a) && has(b) ? Math.max(1, Math.round((distM(a.lat, a.lng, b.lat, b.lng) * 13) / 1000)) : 0);
  const route = (a, b) => [a, b].filter(has);
  const pathLen = (pts) => Math.round(pts.slice(1).reduce((s, p, i) => s + distM(pts[i].lat, pts[i].lng, p.lat, p.lng), 0) * 1.3);
  const bearing = (a, b) => { const r = Math.PI / 180; const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r); const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r); return (Math.atan2(y, x) / r + 360) % 360; };
  const pointAt = (pts, t) => { if (pts.length < 2) return { ...pts[0], angle: 0 }; const a = pts[0], b = pts[pts.length - 1], f = Math.min(1, Math.max(0, t)); return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, angle: bearing(a, b) }; };
  // Uganda, generously: positions outside this box are treated as bad fixes
  const onMap = (p) => has(p) && p.lat > -1.6 && p.lat < 4.4 && p.lng > 29.4 && p.lng < 35.2;
  S.geo = { route, pathLen, pointAt, onMap, distM, km10, bearing, has };
  const kmBetween = (a, b) => km10(a, b) / 10;
  const minsFor = (metres, clsId) => (metres / 1000 / (cls(clsId).speed || 30)) * 60;

  /* ---------------- vehicles, pricing, recommendation ---------------- */
  function eligibleClasses(pkg) {
    const size = sizeOf(pkg.size);
    if (!size) return [];
    return size.eligible.filter((c) => cls(c).enabled && cls(c).maxKg >= (+pkg.weight || 0));
  }
  function recommend(pkg) {
    const size = sizeOf(pkg.size);
    const el = eligibleClasses(pkg);
    if (!size || !el.length) return null;
    if (el.includes(size.best)) return size.best;
    const bi = D.CLASS_ORDER.indexOf(size.best);
    return el.find((c) => D.CLASS_ORDER.indexOf(c) >= bi) || el[0];
  }
  // Same integer maths as public._quote(), so the preview equals the charge.
  function quote({ pickup, dropoff, cls: c, fragile, express }) {
    const p = st().pricing[c];
    if (!p || !pickup || !dropoff) return { km: 0, lines: [], total: 0, commission: 0 };
    const k10 = km10(pickup, dropoff);
    const km = k10 / 10;
    const lines = [{ label: 'Base fare · ' + cls(c).label.toLowerCase(), amount: p.base }, { label: 'Distance · ' + km + ' km', amount: Math.round((k10 * p.perKm) / 5000) * 500 }];
    if (fragile) lines.push({ label: 'Fragile handling', amount: p.fragile });
    if (express) lines.push({ label: 'Express · first available driver', amount: p.express });
    let total = lines.reduce((s, l) => s + l.amount, 0);
    if (total < p.min) { lines.push({ label: 'Minimum fare top-up', amount: p.min - total }); total = p.min; }
    total = Math.round(total / 500) * 500;
    return { km, lines, total, commission: p.commission };
  }
  const riderShareOf = (total, commission) => Math.round((total * (1 - commission / 100)) / 100) * 100;
  Object.assign(S, { eligibleClasses, recommend, quote, kmBetween, minsFor });
  S.riderShare = (d) => (d.earning != null && d.status !== 'searching' ? d.earning : riderShareOf(d.price.total, d.price.commission));

  // Validates a vendor's delivery draft step by step. Returns { field: message }. The server repeats every check.
  function validateDraft(dr, step) {
    const e = {};
    const steps = ['route', 'recipient', 'package', 'vehicle', 'review'];
    const upto = steps.indexOf(step);
    if (upto >= 0) {
      if (!dr.pickup) e.pickup = 'Choose where the driver collects the package.';
      if (!dr.dropoff) e.dropoff = 'Choose where the package is going.';
      if (dr.pickup && dr.dropoff && dr.pickup === dr.dropoff) e.dropoff = 'Drop-off must be different from pickup.';
      const dz = dr.dropoff && place(dr.dropoff);
      if (dz && !zone(dz.zone).enabled) e.dropoff = dz.area + ' is outside our live service area. Pick another address or ask ops to open ' + zone(dz.zone).name + '.';
    }
    if (upto >= 1) {
      if (!dr.rName || dr.rName.trim().length < 2) e.rName = "Enter the recipient's name.";
      const digits = (dr.rPhone || '').replace(/\D/g, '');
      if (!/^(256)?0?7\d{8}$/.test(digits)) e.rPhone = 'Enter a Ugandan mobile number, e.g. 0753 512 640.';
    }
    if (upto >= 2) {
      if (!dr.type) e.type = 'Pick what you are sending.';
      if (!dr.desc || dr.desc.trim().length < 3) e.desc = 'Describe the package so the driver can recognise it.';
      const w = +dr.weight;
      const sz = dr.size && sizeOf(dr.size);
      if (!dr.size) e.size = 'Choose a package size.';
      if (!w || w <= 0) e.weight = 'Enter an approximate weight.';
      else if (w > 5000) e.weight = 'Our largest truck carries 5,000 kg. Split this into several deliveries.';
      else if (sz && w > sz.maxKg) e.weight = w + ' kg is too heavy for a ' + sz.label + ' package. Choose a larger size.';
      if (!e.weight && sz && !eligibleClasses({ size: dr.size, weight: w }).length) e.size = 'No enabled vehicle class can carry this. Ops has switched off the vehicles it needs.';
      if (dr.value && !/^\d+$/.test(String(dr.value).trim())) e.value = 'Enter the value in whole shillings.';
      if (dr.photoUploading) e.photo = 'Wait for the photo to finish uploading.';
    }
    if (upto >= 3) {
      const el = eligibleClasses({ size: dr.size, weight: +dr.weight });
      if (!dr.cls) e.cls = 'Choose a vehicle.';
      else if (!el.includes(dr.cls)) e.cls = 'A ' + cls(dr.cls).label.toLowerCase() + " can't carry this package. Pick one of the available vehicles.";
    }
    return e;
  }
  S.validateDraft = validateDraft;
  S.normPhone = (p) => {
    let d = (p || '').replace(/\D/g, '');
    if (d.startsWith('256')) d = d.slice(3);
    if (d.startsWith('0')) d = d.slice(1);
    return '+256 ' + d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6, 9);
  };
  S.validPhone = (p) => /^(256)?0?7\d{8}$/.test((p || '').replace(/\D/g, ''));
  S.validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((e || '').trim());
  S.passwordProblem = (pw) => (!pw || pw.length < 8 ? 'Use at least 8 characters.' : !/[A-Za-z]/.test(pw) || !/\d/.test(pw) ? 'Use letters and at least one number.' : null);

  /* ---------------- live position, ETA and matching (derived, never simulated) ---------------- */
  // A rider's leg to the next stop, built from their last real GPS fix. Null when no fix is available.
  function legOf(d) {
    const r = rider(d.riderId);
    if (!r || !r.loc || !D.ACTIVE.includes(d.status) || d.status === 'searching') return null;
    const kind = ['assigned', 'en_route_pickup', 'at_pickup'].includes(d.status) ? 'pickup' : 'dropoff';
    const pts = route(r.loc, kind === 'pickup' ? d.pickup : d.dropoff);
    return { kind, pts, len: pathLen(pts), t: 0, live: true };
  }
  function etaMin(d) {
    if (d.leg) return minsFor(d.leg.len + (d.leg.kind === 'pickup' ? pathLen(route(d.pickup, d.dropoff)) : 0), d.cls);
    const trip = minsFor(pathLen(route(d.pickup, d.dropoff)), d.cls);
    if (['in_transit', 'approaching'].includes(d.status)) {
      const started = (d.events.slice().reverse().find((e) => e.type === 'in_transit') || {}).ts || d.statusAt;
      return Math.max(d.status === 'approaching' ? 2 : 3, trip - (Date.now() - started) / MIN);
    }
    if (['arrived', 'awaiting_confirmation'].includes(d.status)) return 0;
    return trip + 10;
  }
  S.etaMs = (d) => etaMin(d) * MIN;
  S.legEtaMin = (d) => (d.leg ? minsFor(d.leg.len, d.cls) : ['in_transit', 'approaching'].includes(d.status) ? etaMin(d) : null);
  S.etaLive = (d) => !!d.leg;

  function candidates(d, opts) {
    const o = opts || {};
    const el = eligibleClasses(d.pkg);
    const ci = D.CLASS_ORDER.indexOf(d.cls);
    const allowed = d.widened ? el.filter((c) => D.CLASS_ORDER.indexOf(c) >= ci) : el.filter((c) => o.anyEligible || c === d.cls);
    return st().riders
      .filter((r) => r.verified && r.accountStatus !== 'suspended' && r.cls && (o.includeOffline || r.online) && (o.includeBusy || !r.activeUuid) && allowed.includes(r.cls) && r.id !== d.riderId)
      .map((r) => {
        const units = r.loc ? pathLen(route(r.loc, d.pickup)) : null;
        const fit = r.cls === d.cls ? 1 : 0.7;
        const distScore = units == null ? 0.4 : Math.max(0, 1 - units / 20000);
        const score = Math.round(100 * (0.35 * fit + 0.35 * distScore + 0.15 * Math.max(0, r.rating - 4) + 0.15 * (r.acceptance / 100)));
        return { rider: r, units, eta: units == null ? null : minsFor(units, r.cls), score, busy: !!r.activeUuid, offline: !r.online };
      })
      .sort((a, b) => b.score - a.score);
  }
  S.candidates = candidates;

  /* ---------------- snapshot → read model ---------------- */
  const ms = (t) => (t ? new Date(t).getTime() : null);
  const pt = (p) => ({ placeId: p.placeId, name: p.name, area: p.area, x: +p.x, y: +p.y, lat: p.lat, lng: p.lng });
  const coordOf = (lat, lng) => (lat == null || lng == null ? null : { lat: +lat, lng: +lng });
  const media = (bucket, path, ts) => (path ? { bucket, path, ts: ts || null } : null);

  S.load = (raw) => {
    if (!raw) { S.state = null; emit('reset'); return; }
    const prev = S.state;
    D.PLACES = (raw.places || []).map((p) => ({ ...p, x: +p.x, y: +p.y }));
    D.SIZES = (raw.sizes || []).map((s) => ({ ...s, maxKg: +s.maxKg }));
    const s = {
      get clock() { return Date.now(); },
      serverNow: ms(raw.now), me: raw.me, settings: raw.settings || {},
      classes: (raw.classes || []).map((c) => ({ ...c, maxKg: +c.maxKg, speed: +c.speed })),
      zones: raw.zones || [],
      pricing: Object.fromEntries(Object.entries(raw.pricing || {}).map(([k, p]) => [k, { base: +p.base, perKm: +p.perKm, min: +p.min, fragile: +p.fragile, express: +p.express, commission: +p.commission }]))
    };
    const refOf = {};
    (raw.deliveries || []).forEach((x) => { refOf[x.id] = x.ref; });
    s.vendors = (raw.vendors || []).map((v) => ({
      id: v.id, name: v.name, initials: v.initials, category: v.category, owner: v.owner, ownerId: v.ownerId, phone: v.phone, email: v.email,
      address: v.address, registrationNo: v.registrationNo, tin: v.tin, verification: v.verification, verified: v.verification === 'verified',
      locations: v.locations || [], staff: v.staff || [], methods: (v.methods || []).filter((m) => m.id !== 'credit' || v.creditEligible),
      defaultMethod: v.defaultMethod, accountStatus: v.accountStatus, isDemo: v.isDemo, createdAt: ms(v.createdAt),
      wallet: v.wallet ? +v.wallet.balance : 0, walletPending: v.wallet ? +v.wallet.pending : 0,
      credit: { eligible: !!v.creditEligible, limit: v.credit ? +v.credit.limit : 0, used: v.credit ? -v.credit.balance : 0, pending: v.credit ? +v.credit.pending : 0,
        due: 'Day ' + v.creditDueDay + ' of the month' }
    }));
    s.riders = (raw.riders || []).map((r) => {
      const veh = r.vehicle || {};
      let loc = null;
      if (r.loc) { loc = { lat: +r.loc.lat, lng: +r.loc.lng, angle: r.loc.heading || 0, accuracy: r.loc.accuracy, updatedAt: ms(r.loc.updatedAt) }; loc.onMap = onMap(loc); if (!loc.onMap || Date.now() - loc.updatedAt > 30 * MIN) loc = { ...loc, hidden: true }; }
      return {
        id: r.id, profileId: r.profileId, name: r.name, initials: r.initials, phone: r.phone || '', email: r.email, rating: +r.rating, trips: r.trips, acceptance: r.acceptance,
        online: r.online, status: r.status, verification: r.verification, verified: r.verification === 'verified', licenseNo: r.licenseNo, accountStatus: r.accountStatus,
        cls: veh.cls || null, make: veh.make || '—', color: veh.color || '', plate: veh.plate || '—', vehicle: r.vehicle,
        activeUuid: r.activeId, activeId: r.activeId ? refOf[r.activeId] || r.activeId : null,
        loc: loc && !loc.hidden ? loc : null, lastFix: loc, balance: r.wallet ? +r.wallet.balance : 0, since: F.since(r.createdAt), createdAt: ms(r.createdAt), isDemo: r.isDemo
      };
    });
    const tickets = (raw.tickets || []).map((t) => ({ id: t.ref, uuid: t.id, did: refOf[t.deliveryId] || null, deliveryId: t.deliveryId, by: t.by, type: t.category, title: t.title,
      note: t.note, status: t.status, createdAt: ms(t.createdAt), updatedAt: ms(t.updatedAt), resolvedAt: ms(t.resolvedAt), resolution: t.resolution, resolutionNote: t.resolutionNote,
      assignedTo: t.assignedTo, vendorId: t.vendorId, riderId: t.riderId }));
    const ticketRef = Object.fromEntries(tickets.map((t) => [t.uuid, t.id]));
    s.deliveries = (raw.deliveries || []).map((x) => {
      const pf = x.proof || {}, pay = x.payment || {};
      const d = {
        id: x.ref, uuid: x.id, vendorId: x.vendorId, status: x.status, statusAt: ms(x.statusAt), createdAt: ms(x.createdAt),
        pickup: pt(x.pickup), dropoff: pt(x.dropoff),
        recipient: x.recipient ? { name: x.recipient.name, phone: x.recipient.phone, notes: x.notes || '' } : { name: 'Recipient', phone: '', notes: '', hidden: true },
        pkg: { ...x.pkg, weight: +x.pkg.weight, value: +x.pkg.value || 0, photo: media('package-photos', x.pkg.photoPath) },
        urgency: x.urgency, cls: x.cls, recommended: x.recommended, widened: x.widened, noDriver: x.noDriver,
        price: { total: +x.price.total, km: +x.price.km, lines: x.price.lines || [], commission: +x.price.commission },
        riderId: x.riderId, vehicleId: x.vehicleId, earning: x.earning, sigRequired: x.sigRequired, promisedAt: ms(x.promisedAt),
        pickupPin: x.secrets ? x.secrets.pickupPin : null, token: x.secrets ? x.secrets.token : null,
        proof: {
          pickup: { photo: media('proofs', pf.pickupPhotoPath, ms(pf.pickupAt)), ts: ms(pf.pickupAt), coord: coordOf(pf.pickupLat, pf.pickupLng), pinOk: !!pf.pickupPinOk },
          drop: { pinOk: !!pf.pinConfirmed, pinBy: pf.pinConfirmedBy, attempts: x.pinAttempts || 0, photo: media('proofs', pf.photoPath, ms(pf.photoAt)),
            signature: media('proofs', pf.signaturePath), receivedBy: pf.receivedBy || 'recipient', receiverName: pf.receiverName || '',
            coord: coordOf(pf.lat, pf.lng), lat: pf.lat, lng: pf.lng, distM: pf.distanceM == null ? null : +pf.distanceM, ts: ms(pf.deliveredAt), locSource: pf.locationSource,
            recipientConfirmed: !!pf.recipientConfirmed }
        },
        payment: { id: pay.id, method: pay.method || 'wallet', status: pay.status || 'pending', amount: +pay.amount || 0, refunded: +pay.refunded || 0, simulated: pay.simulated !== false,
          providerRef: pay.providerRef, provider: pay.provider, checkoutUrl: pay.checkoutUrl, failureReason: pay.failureReason, expiresAt: ms(pay.expiresAt) },
        receipt: pay.receiptNo && ['successful', 'refunded', 'partially_refunded', 'disputed'].includes(pay.status) && ['delivered', 'disputed'].includes(x.status)
          ? { id: pay.receiptNo, ts: ms(pay.capturedAt), lines: x.price.lines || [], total: +pay.amount, vat: +pay.vat || 0, method: pay.method } : null,
        events: (x.events || []).map((e) => ({ id: e.id, ts: ms(e.ts), type: e.type, label: e.label, actor: e.actor, lat: e.lat, lng: e.lng, coord: coordOf(e.lat, e.lng) })),
        chat: (x.chat || []).map((m) => ({ from: m.from, text: m.text, ts: ms(m.ts) })),
        flags: x.flags || [], flagNote: x.flagNote, failReason: x.failReason, cancelReason: x.cancelReason, resolution: x.resolution, handover: x.handover,
        unreachable: x.unreachableAt ? { startReal: ms(x.unreachableAt), calls: x.unreachableCalls } : null, rating: x.rating,
        recipientOpened: ms(x.recipientOpenedAt), declined: x.declinedByMe ? [raw.me.riderId] : [], declinedByMe: !!x.declinedByMe,
        eligibleOnline: x.eligibleOnline, disputeTicket: x.disputeTicketId ? ticketRef[x.disputeTicketId] || null : null, isDemo: x.isDemo
      };
      d.late = D.ACTIVE.includes(d.status) && !['searching', 'draft'].includes(d.status) && d.promisedAt && Date.now() > d.promisedAt + 5 * MIN;
      return d;
    });
    s.tickets = tickets;
    s.transactions = (raw.transactions || []).map((t) => ({ id: t.ref, uuid: t.id, ts: ms(t.ts), party: t.party, partyId: t.partyId, wallet: t.wallet, type: t.type,
      amount: +t.amount, balanceAfter: +t.balanceAfter, method: t.method, label: t.label, did: refOf[t.deliveryId] || null, paymentId: t.paymentId, status: t.status, simulated: t.simulated }));
    s.payments = (raw.payments || []).map((p) => ({ ...p, amount: +p.amount, did: refOf[p.deliveryId] || null, createdAt: ms(p.createdAt), updatedAt: ms(p.updatedAt), expiresAt: ms(p.expiresAt),
      events: (p.events || []).map((e) => ({ ...e, ts: ms(e.ts) })) }));
    s.limits = raw.limits || null;
    const notes = (raw.notifications || []).map((n) => ({ id: n.id, ts: ms(n.ts), aud: n.aud, to: n.aud === 'vendor' ? n.vendorId : n.aud === 'rider' ? n.riderId : null,
      title: n.title, body: n.body, did: refOf[n.deliveryId] || null, deliveryId: n.deliveryId, kind: n.kind, read: n.read, channel: n.channel, phone: n.phone, smsStatus: n.smsStatus }));
    s.notifications = notes.filter((n) => n.channel === 'in_app');
    s.sms = notes.filter((n) => n.channel === 'sms');
    s.disputes = raw.disputes || [];
    s.verifications = (raw.verifications || []).map((v) => ({ ...v, createdAt: ms(v.createdAt), updatedAt: ms(v.updatedAt), submittedAt: ms(v.submittedAt), reviewedAt: ms(v.reviewedAt) }));
    s.audit = (raw.audit || []).map((a) => ({ ...a, ts: ms(a.ts) }));
    S.state = s;
    s.deliveries.forEach((d) => { d.leg = legOf(d); });
    // in-app notifications that arrived since the last load become toasts
    if (prev && prev.me && prev.me.id === s.me.id) {
      const seen = new Set(prev.notifications.map((n) => n.id));
      s.notifications.filter((n) => !seen.has(n.id) && !n.read && Date.now() - n.ts < 2 * MIN).slice(0, 3).reverse()
        .forEach((n) => S.notifyListeners.forEach((fn) => { try { fn(n); } catch (e) { console.error(e); } }));
    }
    emit(prev ? 'change' : 'reset');
  };

  /* ---------------- change events ---------------- */
  let raf = null;
  function emit(kind) {
    if (raf) return;
    const run = () => { if (!raf) return; cancelAnimationFrame(raf.a); clearTimeout(raf.t); raf = null; S.listeners.forEach((fn) => fn(kind)); };
    raf = { a: requestAnimationFrame(run), t: setTimeout(run, 40) };
  }
  S.subscribe = (fn) => { S.listeners.add(fn); return () => S.listeners.delete(fn); };
  S.onNotify = (fn) => { S.notifyListeners.add(fn); return () => S.notifyListeners.delete(fn); };
  S.emit = emit;

  /* ---------------- actions: each one is a server function, followed by a reload ---------------- */
  const act = (S.act = {});
  const call = (fn, args) => D.api.call(fn, args);
  const uuidOf = (id) => { const d = delivery(id); must(d, 'Delivery not found. It may have been removed.'); return d.uuid; };
  const after = async (p) => { const out = await p; await D.api.refresh(); return out; };
  const wrap = (fn) => (...a) => after(fn(...a));

  // vendor
  // A random key per attempt: retrying the same tap (slow network, double click) never creates a second payment.
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  S.payment = (id) => id && st().payments.find((p) => p.id === id);
  // Sends a pending payment to the provider (Edge Function). The reconcile job retries if this call is lost.
  act.initiatePayment = async (paymentId) => {
    const out = await D.api.fn('payments-initiate', { payment_id: paymentId });
    await D.api.refresh();
    return out;
  };
  act.confirmDelivery = async (vendorId, dr) => {
    const errs = validateDraft(dr, 'review');
    must(!Object.keys(errs).length, Object.values(errs)[0] || 'Check the delivery details.');
    const q = quote({ pickup: place(dr.pickup), dropoff: place(dr.dropoff), cls: dr.cls, fragile: dr.fragile, express: dr.urgency === 'express' });
    dr.key = dr.key || newKey();
    const out = await call('create_delivery', { p: { pickup: dr.pickup, dropoff: dr.dropoff, recipient_name: dr.rName.trim(), recipient_phone: dr.rPhone, notes: (dr.notes || '').trim(),
      type: dr.type, description: dr.desc.trim(), size: dr.size, weight: +dr.weight, value: dr.value ? +dr.value : 0, fragile: !!dr.fragile, upright: !!dr.upright,
      urgency: dr.urgency, vehicle_class: dr.cls, method: dr.method, payer_phone: dr.payerPhone || null, photo_path: dr.photo && dr.photo.path ? dr.photo.path : null,
      quoted_total: q.total, idempotency_key: dr.key } });
    if (out.awaitingPayment) await D.api.fn('payments-initiate', { payment_id: out.paymentId }).catch(() => null);
    await D.api.refresh();
    return { delivery: delivery(out.ref) || { id: out.ref }, awaitingPayment: !!out.awaitingPayment, paymentId: out.paymentId };
  };
  act.startTopUp = async (amount, method, phone) => {
    const out = await call('payment_start_topup', { p_amount: Math.round(+amount) || 0, p_method: method, p_phone: phone || null, p_key: newKey() });
    const sent = await D.api.fn('payments-initiate', { payment_id: out.paymentId }).catch((e) => ({ ok: false, error: e.message }));
    await D.api.refresh();
    return { paymentId: out.paymentId, sent };
  };
  act.cashOut = async (amount) => {
    const out = await call('request_payout', { p_amount: amount ? Math.round(+amount) : null, p_key: newKey() });
    if (!out.needsApproval) await D.api.fn('payments-initiate', { payment_id: out.paymentId }).catch(() => null);
    await D.api.refresh();
    return out;
  };
  act.availableDrivers = () => call('available_drivers');
  act.completeSignup = wrap((p) => call('complete_signup', { p }));
  act.saveKyc = wrap((p) => call('save_kyc', { p }));
  act.uploadPackagePhoto = async (vendorId, photo) => {
    const path = vendorId + '/' + Date.now().toString(36) + '.jpg';
    await D.api.upload('package-photos', path, photo.blob, 'image/jpeg');
    D.api.cacheLocal('package-photos', path, photo.src);
    return { bucket: 'package-photos', path, src: photo.src, ts: photo.ts };
  };
  act.vendorCancel = wrap((did, reason) => call('vendor_cancel', { p_delivery: uuidOf(did), p_reason: reason || null }));
  act.widen = wrap((did) => call('widen_search', { p_delivery: uuidOf(did) }));
  act.reattempt = wrap((did) => call('resolve_failed', { p_delivery: uuidOf(did), p_choice: 'reattempt' }));
  act.returnToVendor = wrap((did) => call('resolve_failed', { p_delivery: uuidOf(did), p_choice: 'return' }));
  act.payInvoice = wrap(() => call('pay_credit_invoice'));
  act.setDefaultMethod = wrap((vid, m) => call('set_default_method', { p_method: m }));
  act.openTicket = wrap(({ did, type, note }) => call('open_ticket', { p_delivery: did ? uuidOf(did) : null, p_category: type || '', p_description: note || '', p_attachments: [] }));
  act.call = wrap((did, from, to) => call('log_call', { p_delivery: uuidOf(did), p_to: to }));
  act.markRead = wrap(() => call('mark_notifications_read'));
  act.updateProfile = wrap((p) => call('update_my_profile', { p }));
  act.submitVerification = wrap(() => call('submit_verification'));
  act.uploadDocument = async (kind, file) => {
    must(file, 'Choose a file.');
    must(file.size <= 10 * 1024 * 1024, 'Documents must be under 10 MB.');
    must(/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type), 'Upload a photo (JPG, PNG) or a PDF.');
    const me = S.me();
    const ext = file.type === 'application/pdf' ? 'pdf' : file.type.split('/')[1].replace('jpeg', 'jpg');
    const path = me.id + '/' + kind + '-' + Date.now().toString(36) + '.' + ext;
    await D.api.upload('documents', path, file, file.type);
    return after(call('register_document', { p_kind: kind, p_path: path, p_file_name: file.name || kind + '.' + ext, p_mime: file.type, p_size: file.size }));
  };

  // rider
  act.setOnline = wrap((rid, on) => (S.me().role === 'ops' ? call('ops_set_rider_online', { p_rider: rid, p_online: on }) : call('rider_set_online', { p_online: on })));
  act.acceptOffer = wrap((did) => call('accept_delivery', { p_delivery: uuidOf(did) }));
  act.claimJob = act.acceptOffer;
  act.declineOffer = wrap((did, rid, reason) => call('decline_delivery', { p_delivery: uuidOf(did), p_reason: reason || null }));
  act.startToPickup = wrap((did) => call('rider_start_trip', { p_delivery: uuidOf(did) }));
  act.arriveAtPickup = wrap((did) => call('rider_arrive_pickup', { p_delivery: uuidOf(did) }));
  act.setPhoto = async (did, stage, photo) => {
    const id = uuidOf(did);
    must(photo && photo.blob, 'Take or choose a photo first.');
    const path = id + '/' + stage + '-' + Date.now().toString(36) + '.jpg';
    await D.api.upload('proofs', path, photo.blob, 'image/jpeg');
    D.api.cacheLocal('proofs', path, photo.src);
    return after(call('rider_set_photo', { p_delivery: id, p_stage: stage, p_path: path }));
  };
  act.confirmPickup = wrap((did, pin) => call('rider_confirm_pickup', { p_delivery: uuidOf(did), p_pin: pin || '' }));
  act.startDelivery = wrap((did) => call('rider_start_delivery', { p_delivery: uuidOf(did) }));
  act.markApproaching = wrap((did) => call('rider_mark_approaching', { p_delivery: uuidOf(did) }));
  act.arriveAtDropoff = wrap((did) => call('rider_arrive_dropoff', { p_delivery: uuidOf(did) }));
  act.startHandoff = wrap((did) => call('rider_start_handoff', { p_delivery: uuidOf(did) }));
  act.submitDeliveryPin = wrap((did, pin) => call('rider_submit_pin', { p_delivery: uuidOf(did), p_pin: pin || '' }));
  act.setSignature = async (did, dataUrl) => {
    const id = uuidOf(did);
    if (!dataUrl) return after(call('rider_set_signature', { p_delivery: id, p_path: null }));
    const path = id + '/signature-' + Date.now().toString(36) + '.png';
    await D.api.upload('proofs', path, D.api.dataUrlToBlob(dataUrl), 'image/png');
    D.api.cacheLocal('proofs', path, dataUrl);
    return after(call('rider_set_signature', { p_delivery: id, p_path: path }));
  };
  act.setReceiver = wrap((did, who, name) => call('rider_set_receiver', { p_delivery: uuidOf(did), p_who: who, p_name: name || null }));
  act.completeDelivery = wrap((did) => call('rider_complete', { p_delivery: uuidOf(did) }));
  act.riderCancel = wrap((did, reason) => call('rider_release', { p_delivery: uuidOf(did), p_reason: reason || null }));
  act.reportVehicleIssue = wrap((did) => call('rider_report_vehicle_issue', { p_delivery: uuidOf(did) }));
  act.reportUnreachable = wrap((did) => call('rider_report_unreachable', { p_delivery: uuidOf(did) }));
  act.markFailed = wrap((did, reason) => call('rider_mark_failed', { p_delivery: uuidOf(did), p_reason: reason || null }));
  act.sendChat = wrap((did, from, text) => { must((text || '').trim(), 'Type a message first.'); return call('send_message', { p_delivery: uuidOf(did), p_body: text }); });
  act.sos = wrap((did) => call('rider_sos', { p_delivery: did ? uuidOf(did) : null }));
  act.updateVehicle = wrap((p) => call('update_vehicle', { p }));

  // ops
  act.opsAssign = wrap((did, rid) => call('ops_assign', { p_delivery: uuidOf(did), p_rider: rid }));
  act.opsReassign = wrap((did, rid, reason) => call('ops_reassign', { p_delivery: uuidOf(did), p_rider: rid, p_reason: reason || null }));
  act.opsCancel = wrap((did, reason) => call('ops_cancel', { p_delivery: uuidOf(did), p_reason: reason || '' }));
  act.opsFlag = wrap((did, note) => call('ops_flag', { p_delivery: uuidOf(did), p_note: note || null }));
  act.opsFail = wrap((did, reason) => call('ops_fail', { p_delivery: uuidOf(did), p_reason: reason || '' }));
  act.opsResendPin = wrap((did) => call('ops_resend_pin', { p_delivery: uuidOf(did) }));
  const ticket = (tid) => st().tickets.find((t) => t.id === tid || t.uuid === tid);
  act.resolveTicket = wrap((tid, decision, note) => {
    const t = ticket(tid);
    must(t, 'Case not found.');
    return ['refund_full', 'refund_half', 'reject'].includes(decision)
      ? call('ops_resolve_dispute', { p_ticket: t.uuid, p_decision: decision, p_note: note || null })
      : call('ops_update_ticket', { p_ticket: t.uuid, p_status: 'resolved', p_note: note || null });
  });
  act.updateTicket = wrap((tid, status, note) => call('ops_update_ticket', { p_ticket: ticket(tid).uuid, p_status: status, p_note: note || null }));
  act.reviewVerification = wrap((rid, decision, note) => call('ops_review_verification', { p_request: rid, p_decision: decision, p_note: note || null }));
  act.setAccountStatus = wrap((pid, status, reason) => call('ops_set_account_status', { p_profile: pid, p_status: status, p_reason: reason || null }));
  const PRICE_FIELD = { base: 'base', perKm: 'per_km', min: 'min_fare', fragile: 'fragile', express: 'express', commission: 'commission_pct' };
  act.updatePricing = wrap((c, field, value) => { const v = +String(value).replace(/[^\d.]/g, ''); must(Number.isFinite(v) && String(value).trim() !== '', 'Enter a number.'); return call('ops_update_pricing', { p_class: c, p_field: PRICE_FIELD[field], p_value: v }); });
  act.updateClass = wrap((id, patch) => call('ops_update_class', { p_class: id, p_enabled: patch.enabled == null ? null : patch.enabled, p_max_kg: patch.maxKg == null ? null : +patch.maxKg }));
  act.toggleZone = wrap((id) => call('ops_toggle_zone', { p_zone: id }));
  act.setSetting = wrap((k, v) => call('ops_set_setting', { p_key: k, p_value: v }));
  act.setCredit = wrap((vid, limit) => call('ops_set_credit', { p_vendor: vid, p_limit: Math.round(+limit) || 0 }));
  act.reviewPayout = async (pid, approve, note) => {
    await call('ops_review_payout', { p_payment: pid, p_approve: approve, p_note: note || null });
    if (approve) await D.api.fn('payments-initiate', { payment_id: pid }).catch(() => null);
    await D.api.refresh();
  };
  act.clearPaymentReview = wrap((pid, note) => call('ops_clear_payment_review', { p_payment: pid, p_note: note || '' }));
  act.ledgerCheck = () => call('ledger_check');
})();
