/* Drop Off — recipient experience. No app or account: a secure tracking link (token) plus the last 4 digits of the
   phone it was sent to. Everything is read through recipient_view(), which only returns that one delivery. */
(function () {
  const D = window.DO, html = D.html, S = D.store, F = D.fmt, U = D.ui;
  const { Icon, VIcon, Chip, Progress, Btn, MapView, PhotoView, Avatar, Empty, PinPad, Timeline } = D;
  const dev = 'recipient';
  const A = D.api;
  const T = () => U.tmpOf.recipient;
  const go = (s, p) => D.nav(dev, s, p);
  const R = (D.rec = { token: null, code: null, raw: null, error: null, loading: false, proof: null });
  const LINKS = 'dropoff-recipient-links';
  const links = () => { try { return JSON.parse(localStorage.getItem(LINKS) || '[]'); } catch (e) { return []; } };
  const remember = (raw) => { try { const l = links().filter((x) => x.token !== R.token); l.unshift({ token: R.token, ref: raw.ref, vendor: raw.vendor.name, desc: raw.pkg.desc, at: Date.now() }); localStorage.setItem(LINKS, JSON.stringify(l.slice(0, 20))); } catch (e) { /* storage unavailable */ } };
  const codeKey = (t) => 'dropoff-rc-' + t;
  const savedCode = (t) => { try { return sessionStorage.getItem(codeKey(t)); } catch (e) { return null; } };

  // turn the server payload into the shape the shared components (map, timeline, chips) expect
  function view() {
    const x = R.raw;
    if (!x) return null;
    const ms = (t) => (t ? new Date(t).getTime() : null);
    const d = {
      id: x.ref, status: x.status, statusAt: ms(x.statusAt), createdAt: ms(x.createdAt), promisedAt: ms(x.promisedAt), cls: x.cls,
      vendor: x.vendor, recipient: x.recipient, pkg: x.pkg, km: x.km, failReason: x.failReason, cancelReason: x.cancelReason, rating: x.rating,
      pickup: { ...x.pickup, lat: x.pickup.lat == null ? null : +x.pickup.lat, lng: x.pickup.lng == null ? null : +x.pickup.lng },
      dropoff: { ...x.dropoff, lat: x.dropoff.lat == null ? null : +x.dropoff.lat, lng: x.dropoff.lng == null ? null : +x.dropoff.lng },
      deliveryPin: x.deliveryPin, pinAttempts: x.pinAttempts, sigRequired: x.sigRequired, riderInfo: x.rider, proof: x.proof,
      events: (x.events || []).map((e) => ({ ...e, ts: ms(e.ts), actor: { name: { rider: 'Rider', vendor: x.vendor.name, recipient: 'You', ops: 'Drop Off support', system: 'Drop Off' }[e.actor] || '' } })),
      chat: (x.chat || []).map((m) => ({ ...m, ts: ms(m.ts) })), sms: (x.sms || []).map((m) => ({ ...m, ts: ms(m.ts) }))
    };
    let rider = null;
    if (x.rider) {
      let loc = null;
      if (x.loc) { const p = { lat: +x.loc.lat, lng: +x.loc.lng }; if (S.geo.onMap(p)) loc = { ...p, angle: x.loc.heading || 0, updatedAt: ms(x.loc.updatedAt) }; }
      rider = { id: x.rider.id, name: x.rider.name, loc, online: true, activeId: d.id };
    }
    d.mapRider = rider;
    if (rider && rider.loc && D.ACTIVE.includes(d.status)) {
      const kind = ['assigned', 'en_route_pickup', 'at_pickup'].includes(d.status) ? 'pickup' : 'dropoff';
      const pts = S.geo.route(rider.loc, kind === 'pickup' ? d.pickup : d.dropoff);
      d.leg = { kind, pts, len: S.geo.pathLen(pts), t: 0, live: true };
    } else d.leg = null;
    return d;
  }

  async function load(quiet) {
    if (!R.token || !R.code) return false;
    if (!quiet) { R.loading = true; D.rerender(); }
    try {
      const out = await A.call('recipient_view', { p_token: R.token, p_code: R.code });
      R.raw = out.delivery; R.error = null;
      remember(out.delivery);
      try { sessionStorage.setItem(codeKey(R.token), R.code); } catch (e) { /* ignore */ }
      return true;
    } catch (e) { R.error = e.message; if (!quiet) throw e; return false; }
    finally { R.loading = false; D.rerender(); }
  }
  setInterval(() => { if (R.raw && document.visibilityState === 'visible' && D.ACTIVE.concat(['pending']).includes(R.raw.status)) load(true); }, 8000);
  const call = async (fn, args) => { const out = await A.call(fn, { p_token: R.token, p_code: R.code, ...args }); await load(true); return out; };

  D.recipientOpenToken = (token) => {
    R.token = token; R.raw = null; R.proof = null;
    R.code = savedCode(token);
    U.recipient.stack = [];
    U.recipient.screen = 'verify'; U.recipient.params = {};
    if (R.code) load(false).then(() => { U.recipient.screen = 'track'; D.rerender(); }, () => { R.code = null; D.rerender(); });
    D.rerender();
  };

  const Head = ({ back }) => html`<div class="hdr">${back ? html`<${D.Back} dev=${dev} fallback="lookup" />` : null}<${D.Logo} s="28" /><span class="display" style="font-size:18px">Drop Off</span><span class="chip ok" style="margin-left:auto"><${Icon} n="lock" s="12" w="2.4" />Secure link</span></div>`;

  /* ---------------- find a delivery (no link at hand) ---------------- */
  const Lookup = () => {
    const t = T();
    const mineList = links();
    const acct = S.me() && S.me().role === 'recipient';
    if (acct && !t.loadedAcct) { t.loadedAcct = true; A.call('recipient_my_deliveries').then((l) => { t.acct = l; D.rerender(); }, () => {}); }
    const find = () => D.run('c-find', async () => {
      if (!/^DO-\d+$/i.test((t.ref || '').trim())) throw new D.UserError('Enter the reference from your SMS, like DO-48233.');
      if (!/^\d{4}$/.test(t.l4 || '')) throw new D.UserError('Enter the last 4 digits of your phone number.');
      const out = await A.call('recipient_lookup', { p_ref: t.ref.trim(), p_last4: t.l4 });
      R.token = out.token; R.code = t.l4;
      await load(false);
      U.recipient.stack = [{ screen: 'lookup', params: {} }]; U.recipient.screen = 'track';
    }, { dev });
    return html`<div class="app light" style="background:#fff"><div class="app-scroll">
      <${Head} />
      <h1 class="h-xl">Track a delivery</h1><div class="sub">Open the link in your SMS, or enter the reference and the last 4 digits of your phone. No app or account needed.</div>
      <div class="field"><label for="c-ref">Delivery reference</label><input id="c-ref" class="input mono" placeholder="DO-48233" value=${t.ref || ''} onInput=${(e) => { t.ref = e.target.value.toUpperCase(); }} /></div>
      <div class="field"><label for="c-l4">Last 4 digits of your phone</label><input id="c-l4" class="input mono" inputmode="numeric" maxlength="4" value=${t.l4 || ''} onInput=${(e) => { t.l4 = e.target.value.replace(/\D/g, ''); D.rerender(); }} /></div>
      <${Btn} kind="ink" busy=${D.busy('c-find')} label="Finding…" onClick=${find}>Track delivery<//>
      ${(acct ? t.acct || [] : mineList).length ? html`<div class="eyebrow">${acct ? 'Your deliveries' : 'Opened on this device'}</div><div class="card pad0" style="margin-top:-6px">${(acct ? t.acct : mineList).map((x) => html`<button class="list-row" onClick=${() => D.recipientOpenToken(x.token)}><span class="ibox pine display" style="font-size:12px">${(x.initials || F.initials(x.vendor))}</span><span class="grow"><span class="t1" style="display:block">${x.vendor}</span><span class="t2">${x.ref} · ${x.desc}</span></span>${x.status ? html`<${Chip} status=${x.status} />` : html`<${Icon} n="chevR" s="16" />`}</button>`)}</div>` : null}
      ${acct ? html`<button class="linkbtn" onClick=${() => D.run('signout', () => A.signOut(), { dev: 'global' })}>Sign out</button>` : null}
    </div></div>`;
  };

  /* ---------------- verify it's you ---------------- */
  const Verify = () => {
    const t = T();
    t.code = t.code || '';
    const check = () => D.run('c-verify', async () => {
      R.code = t.code;
      try { await load(false); } catch (e) { t.state = 'bad'; t.code = ''; R.code = null; throw e; }
      t.code = ''; U.recipient.screen = 'track'; U.recipient.params = {};
    }, { dev });
    return html`<div class="app light"><div class="app-scroll">
      <${Head} back=${U.recipient.stack.length > 0} />
      <div class="card ink" style="border-radius:24px;padding:20px;display:flex;flex-direction:column;gap:12px">
        <div class="cap" style="color:#C9D6D1">You have a delivery on the way</div>
        <h1 class="h-lg" style="font-size:26px">Confirm it's you</h1>
        <div class="cap" style="color:#C9D6D1">For your privacy we show the details only to the person this link was sent to.</div>
      </div>
      <div class="card" style="display:flex;flex-direction:column;gap:12px"><div><b style="font-size:16px">Enter the last 4 digits of your phone</b><div class="cap" style="margin-top:2px">The number the SMS was sent to, or your 4-digit delivery PIN.</div></div>
        <${PinPad} value=${t.code} get=${() => T().code} state=${t.state} onChange=${(x) => { T().code = x; T().state = null; D.rerender(); }} /></div>
      ${R.error && !R.raw ? html`<div class="banner bad"><${Icon} n="alert" s="18" /><span>${R.error}</span></div>` : null}
    </div><div class="app-bottom"><${Btn} disabled=${t.code.length !== 4} busy=${D.busy('c-verify')} label="Checking…" onClick=${check}>See my delivery<//><div class="cap" style="text-align:center">No app or account needed</div></div></div>`;
  };

  /* ---------------- live tracking ---------------- */
  const Track = () => {
    const d = view(), t = T();
    if (!d) return html`<${Verify} />`;
    const r = d.riderInfo;
    const st = d.status;
    const rn = r ? r.name : '';
    const RiderRow = () => r ? html`<div style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:18px;background:var(--mist)">
      <button style="display:flex;gap:12px;align-items:center;flex:1;min-width:0;border:0;background:none;text-align:left;padding:0" onClick=${() => go('driver')}><${Avatar} name=${rn} s="44" /><span style="min-width:0"><b style="display:block">${rn}${r.verified ? ' · verified' : ''}</b><span class="cap">${r.color} ${S.cls(r.cls).label === r.cls ? r.cls : S.cls(r.cls).label.toLowerCase()} · <span class="mono" style="color:var(--ink)">${r.plate}</span></span></span></button>
      <button class="iconbtn" aria-label=${'Message ' + rn} onClick=${() => go('chat')}><${Icon} n="msg" s="18" /></button></div>` : null;
    const liveNote = d.mapRider && d.mapRider.loc ? 'Live location · updated ' + F.ago(d.mapRider.loc.updatedAt) : r ? 'Live location not shared yet · times are estimates' : null;
    let sheet;
    if (['searching', 'pending', 'assigned', 'en_route_pickup', 'at_pickup'].includes(st)) {
      sheet = html`<div><h1 class="h-lg">${st === 'searching' || st === 'pending' ? d.vendor.name + ' is booking a driver' : st === 'at_pickup' ? rn + ' is collecting your order' : rn + ' is on the way to ' + d.vendor.name}</h1><div class="sub">${d.pkg.desc}${d.promisedAt ? ' · expected around ' + F.time(Math.max(d.promisedAt, Date.now() + S.etaMs(d))) : ''}</div></div><${Progress} status=${st} /><${RiderRow} />${liveNote ? html`<div class="cap">${liveNote}</div>` : null}`;
    } else if (['picked_up', 'in_transit', 'approaching'].includes(st)) {
      sheet = html`<div style="display:flex;justify-content:space-between;gap:8px"><div><h1 class="h-lg">${st === 'approaching' ? rn + ' is almost there' : F.mins(S.legEtaMin(d)) + ' away'}</h1><div class="sub">${d.leg ? 'Arriving around ' : 'Estimated arrival around '}${F.time(Date.now() + S.etaMs(d))}</div></div><span class="mono cap">${d.id}</span></div>
        <${Progress} status=${st} /><${RiderRow} />${liveNote ? html`<div class="cap">${liveNote}</div>` : null}
        ${st === 'approaching' ? html`<div class="banner mari pop"><${Icon} n="lock" s="18" /><span>Have your PIN ready: <b class="mono">${d.deliveryPin}</b>. Only give it once the package is in your hands.</span></div>` : null}`;
    } else if (st === 'arrived' || st === 'awaiting_confirmation') {
      t.show = t.show == null ? true : t.show;
      t.pin = t.pin || '';
      const confirmed = d.proof.pinConfirmed;
      sheet = html`<div class="pop"><div class="eyebrow" style="color:var(--mari-text)">Arrived</div><h1 class="h-lg">${rn} is at your door</h1><div class="sub">Look for a ${(r.color || '').toLowerCase()} ${S.cls(r.cls).label === r.cls ? r.cls : S.cls(r.cls).label.toLowerCase()} · plate <b class="mono" style="color:var(--ink)">${r.plate}</b></div></div>
        ${d.recipient.notes ? html`<div class="banner mari"><${Icon} n="pin" s="18" /><span>Your instructions: “${d.recipient.notes}”</span></div>` : null}
        <div class="card ink" style="display:flex;flex-direction:column;gap:12px"><div style="display:flex;justify-content:space-between"><b>Your delivery PIN</b><button class="linkbtn" style="color:#C9D6D1;padding:0;font-size:13px" onClick=${() => { t.show = !t.show; D.rerender(); }}>${t.show ? 'Hide' : 'Show'}</button></div>
          <div class="pinboxes">${String(d.deliveryPin || '').split('').map((c) => html`<div class="pinbox" style="background:var(--pine2);border-color:var(--pine3);color:var(--mari);font-size:34px;height:70px">${t.show ? c : '●'}</div>`)}</div>
          <div class="cap" style="color:#C9D6D1">${confirmed ? 'PIN confirmed · ' + rn + ' is finishing the handover' : 'Check the package first. Then read this PIN to ' + rn + ', or confirm it yourself below.'}</div></div>
        ${st === 'awaiting_confirmation' && !confirmed ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Got the package? Confirm with your PIN</b><div class="cap">Entering the PIN here confirms you received it. Don't confirm if something is wrong.</div>
          <${PinPad} value=${t.pin} get=${() => T().pin} state=${t.pinState} onChange=${(x) => { T().pin = x; T().pinState = null; D.rerender(); }} />
          <${Btn} kind="ink md" disabled=${t.pin.length !== 4} busy=${D.busy('c-confirm')} label="Confirming…" onClick=${async () => { const ok = await D.run('c-confirm', async () => { const out = await call('recipient_confirm', { p_pin: t.pin }); t.pin = ''; D.toast(dev, out.delivered ? 'Delivery confirmed. Thank you!' : 'PIN confirmed. The rider is finishing the handover.', 'info'); }, { dev }); if (!ok) { t.pinState = 'bad'; t.pin = ''; D.rerender(); } }}>I received it · confirm<//></div>` : null}
        ${st === 'arrived' ? html`<div class="banner info"><span class="spin" style="width:14px;height:14px;border-radius:50%;border:2.5px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite"></span><span>Waiting for ${rn} to start the handover…</span></div>` : null}
        <${RiderRow} /><button class="linkbtn" onClick=${() => go('help')}>Something wrong with the package? Don't share the PIN</button>`;
    } else if (st === 'delivered' || st === 'disputed') {
      const p = d.proof;
      sheet = html`<div class="pop" style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px"><span style="width:76px;height:76px;border-radius:50%;background:var(--mari);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 10px rgba(255,183,27,.16)"><${Icon} n="check" s="38" w="2.6" /></span><h1 class="h-xl">${st === 'disputed' ? 'Delivered · issue reported' : 'Delivered'}</h1><div class="sub">${p.deliveredAt ? F.full(new Date(p.deliveredAt).getTime()) : ''}</div></div>
        <div class="card pad0" style="background:var(--mist)"><div class="kv"><span>Received by</span><span>${p.receiverName || d.recipient.name} · PIN ✓</span></div><div class="kv"><span>Where</span><span>${d.dropoff.area}${p.distanceM != null ? ' · ' + p.distanceM + ' m from your pin' : ''}</span></div><div class="kv"><span>Rider</span><span>${r ? rn + ' · ' + r.plate : '—'}</span></div><div class="kv"><span>Reference</span><span class="mono">${d.id}</span></div></div>
        <div class="card" style="display:flex;align-items:center;gap:10px;background:var(--mist)"><b style="flex:1">${d.rating ? 'You rated ' + rn : 'How was ' + rn + '?'}</b>${[1, 2, 3, 4, 5].map((n) => html`<button aria-label=${n + ' stars'} style="border:0;background:none;padding:2px" onClick=${() => D.run('c-rate', () => call('recipient_rate', { p_stars: n }), { dev, ok: 'Thanks. ' + d.vendor.name + ' sees your rating.' })}><${Icon} n="star" s="26" c="none" fill=${(d.rating || 0) >= n ? '#FFB71B' : '#E1E6E3'} /></button>`)}</div>
        <div class="row2"><${Btn} kind="ink md" onClick=${() => go('proof')}>View proof<//><${Btn} kind="white md" onClick=${() => go('help')}>Report a problem<//></div>`;
    } else if (st === 'failed') {
      sheet = html`<div class="banner bad"><${Icon} n="alert" s="18" /><span><b>We couldn't complete the delivery.</b> ${d.failReason}. ${d.vendor.name} will contact you about a new attempt.</span></div><${RiderRow} /><${Btn} kind="ink md" onClick=${() => go('help')}>Get help<//>`;
    } else {
      sheet = html`<div class="banner info"><${Icon} n="x" s="18" /><span>${d.vendor.name} cancelled this delivery. Contact them if you expected it.</span></div>`;
    }
    const showMap = !['delivered', 'disputed', 'cancelled'].includes(st);
    return html`<div class="app light" style="background:#E9EDE8">
      ${showMap ? html`<div style="position:relative"><${MapView} d=${d} rider=${d.mapRider} height=${st === 'arrived' || st === 'awaiting_confirmation' ? 230 : 360} label="Delivery map" />
        <div style="position:absolute;top:46px;left:16px;right:16px;display:flex;justify-content:space-between"><button class="iconbtn" aria-label="Back" style="box-shadow:0 4px 14px rgba(13,43,35,.15)" onClick=${() => D.back(dev, 'lookup')}><${Icon} n="chevL" s="22" /></button><span class="map-tag" style="position:static"><span style="width:7px;height:7px;border-radius:50%;background:#3DD68C"></span>${d.vendor.name}</span></div></div>` : html`<div style="padding:46px 16px 0;background:#fff"><button class="iconbtn mist" aria-label="Back" onClick=${() => D.back(dev, 'lookup')}><${Icon} n="chevL" s="22" /></button></div>`}
      <div class="sheet" style=${'flex:1;overflow-y:auto;position:relative;' + (showMap ? 'margin-top:-26px' : 'border-radius:0')}><div class="grabber" style=${showMap ? '' : 'display:none'}></div>${sheet}
        <div class="card pad0" style="background:var(--mist)"><div class="kv"><span>From</span><span>${d.vendor.name}</span></div><div class="kv"><span>Order</span><span>${d.pkg.desc}</span></div><div class="kv"><span>Deliver to</span><span>${d.dropoff.name}</span></div></div>
        <div class="card"><b>Updates</b><div style="margin-top:8px"><${Timeline} events=${d.events} max=${8} /></div></div>
        <div style="display:flex;justify-content:space-between"><button class="linkbtn" onClick=${() => go('messages')}>SMS messages (${d.sms.length})</button><button class="linkbtn" onClick=${() => go('help')}>Help</button></div></div>
    </div>`;
  };

  const Driver = () => {
    const d = view();
    const r = d && d.riderInfo;
    if (!r) return html`<div class="app light"><div class="app-scroll"><${Head} back=${true} /><${Empty} title="No rider yet" body="We'll show your rider as soon as one accepts." /></div></div>`;
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="track" /><b>Your rider</b></div>
      <div class="card" style="display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center"><span style="border:3px solid var(--mari);border-radius:50%"><${Avatar} name=${r.name} s="84" /></span><h1 class="h-lg">${r.name}</h1>${r.verified ? html`<span class="chip ok"><${Icon} n="shield" s="13" />Verified Drop Off rider</span>` : null}<div class="cap">★ ${(+r.rating).toFixed(2)} · ${F.num(r.trips)} deliveries</div></div>
      <div class="card ink" style="display:flex;flex-direction:column;gap:12px"><div style="display:flex;gap:12px;align-items:center"><span class="ibox mari" style="color:var(--ink)"><${VIcon} c=${r.cls} s="26" /></span><div style="flex:1"><b>${r.make}</b><div class="cap" style="color:#C9D6D1">${r.color}</div></div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px;border-radius:14px;background:var(--pine2)"><span style="font-size:13px;color:#C9D6D1">Check the plate before you share your PIN</span><span class="mono" style="background:#fff;color:var(--ink);padding:6px 9px;border-radius:8px;font-size:17px;white-space:nowrap">${r.plate}</span></div></div>
      <div class="card"><b>What Drop Off checked</b><div class="cap" style="margin-top:6px">Ops reviewed this rider's ID, driving permit and vehicle logbook before approving them. Drop Off does not run automated government ID checks yet.</div></div>
      <div class="banner info"><${Icon} n="lock" s="18" /><span>Messages go through Drop Off. ${r.name.split(' ')[0]} never sees your full phone number here.</span></div>
    </div><div class="app-bottom"><${Btn} onClick=${() => go('chat')}><${Icon} n="msg" s="18" />Message ${r.name.split(' ')[0]}<//></div></div>`;
  };

  const Chat = () => {
    const d = view(), t = T();
    if (!d) return null;
    const r = d.riderInfo;
    return html`<div class="app light"><div class="app-scroll" style="gap:10px">
      <div class="hdr"><${D.Back} dev=${dev} fallback="track" />${r ? html`<${Avatar} name=${r.name} s="38" />` : null}<div style="flex:1"><b>${r ? r.name : 'Rider'}</b><div class="cap">Your rider · ${D.STATUS[d.status].label.toLowerCase()}</div></div></div>
      <div class="chip pine" style="align-self:center;height:auto;padding:6px 12px;white-space:normal;text-align:center"><${Icon} n="lock" s="12" />Private chat · kept for support</div>
      ${d.chat.map((m) => html`<div class=${'bubble ' + (m.from === 'recipient' ? 'me' : 'them')} style=${m.from === 'recipient' ? '' : 'background:var(--mist)'}>${m.text}<div class="ts">${F.time(m.ts)}</div></div>`)}
      ${!d.chat.length ? html`<div class="empty">${r ? 'Say hello or share directions.' : 'Messages open once a rider accepts.'}</div>` : null}
      ${r ? html`<div class="pills">${["I'm outside now", 'Call me on arrival', 'Please wait 5 min'].map((q) => html`<button class="pill" onClick=${() => D.run('c-msg', () => call('recipient_send_message', { p_body: q }), { dev })}>${q}</button>`)}</div>` : null}
    </div>${r ? html`<div class="app-bottom raised" style="flex-direction:row;align-items:center"><input class="input" aria-label="Message your rider" placeholder=${'Message ' + r.name.split(' ')[0]} value=${t.msg || ''} onInput=${(e) => { t.msg = e.target.value; D.rerender(); }} style="height:48px;border-radius:999px" /><button class="iconbtn" style="background:var(--ink);color:var(--mari)" aria-label="Send" onClick=${() => D.run('c-msg', async () => { if (!(t.msg || '').trim()) throw new D.UserError('Type a message first.'); await call('recipient_send_message', { p_body: t.msg }); t.msg = ''; }, { dev })}><${Icon} n="send" /></button></div>` : null}</div>`;
  };

  const Proof = () => {
    const d = view();
    if (!d || !['delivered', 'disputed'].includes(d.status)) return html`<div class="app light"><div class="app-scroll"><${Head} back=${true} /><${Empty} title="No proof yet" body="Proof appears here once the delivery is completed." /></div></div>`;
    const p = d.proof;
    if (!R.proof && !R.proofLoading && (p.hasPhoto || p.hasSignature)) {
      R.proofLoading = true;
      A.sb.functions.invoke('recipient-proof', { body: { token: R.token, code: R.code } })
        .then(async ({ data }) => ({ photo: await A.localMedia(data && data.photo), signature: await A.localMedia(data && data.signature) }))
        .then((data) => { R.proof = data || {}; R.proofLoading = false; D.rerender(); }, () => { R.proof = {}; R.proofLoading = false; D.rerender(); });
    }
    const photo = R.proof && R.proof.photo ? { src: R.proof.photo, ts: new Date(p.deliveredAt).getTime() } : p.hasPhoto && !R.proof ? { path: 'pending' } : null;
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="track" /><div style="flex:1"><b>Proof of delivery</b><div class="mono cap">${d.id}</div></div><span class="chip ok"><${Icon} n="shield" s="13" />Verified</span></div>
      <div class="card" style="padding:0;overflow:hidden">${photo && photo.src ? html`<${PhotoView} photo=${photo} h=${190} label="Handover photo" />` : html`<div class="photo" style="height:120px;display:flex;align-items:center;justify-content:center;color:#5F6C67;font-size:13px">${R.proofLoading ? 'Loading photo…' : p.hasPhoto ? 'Photo on file with ' + d.vendor.name : 'No photo'}</div>`}
        <div style="padding:4px 16px"><div class="kv"><span>Recipient confirmation</span><span>PIN ✓${p.pinConfirmedBy === 'recipient' ? ' (you)' : ''} · ${p.receiverName || d.recipient.name}</span></div><div class="kv"><span>Signature</span><span>${R.proof && R.proof.signature ? html`<img src=${R.proof.signature} alt="Signature" style="height:40px;background:#fff;border-radius:6px" />` : p.hasSignature ? 'On file' : 'Not required'}</span></div><div class="kv"><span>GPS</span><span>${p.distanceM != null ? p.distanceM + ' m from your pin' : 'No GPS fix'}</span></div><div class="kv"><span>Timestamp</span><span>${p.deliveredAt ? F.full(new Date(p.deliveredAt).getTime()) : '—'}</span></div><div class="kv"><span>Rider</span><span>${d.riderInfo ? d.riderInfo.name + ' · ' + d.riderInfo.plate : '—'}</span></div></div></div>
      <div class="cap">${d.vendor.name} holds the same record.</div>
    </div></div>`;
  };

  const Messages = () => {
    const d = view();
    return html`<div class="app light" style="background:#fff"><div class="app-scroll" style="gap:10px">
      <div class="hdr"><${D.Back} dev=${dev} fallback="track" /><div style="flex:1"><h1>Messages</h1><div class="cap">SMS sent for ${d ? d.id : ''} · ${d ? d.recipient.phoneMasked : ''}</div></div></div>
      <div class="banner info"><${Icon} n="msg" s="18" /><span>No SMS provider is connected yet, so these messages are recorded but not sent to a phone.</span></div>
      ${d && d.sms.length ? d.sms.map((n) => html`<div style="display:flex;flex-direction:column;gap:4px"><span class="cap" style="padding-left:4px">DROPOFF · ${F.dayTime(n.ts)}</span><span class="bubble them" style="background:var(--mist);max-width:92%;font-size:14px">${n.body}</span></div>`) : html`<${Empty} icon="msg" title="No messages" body="Delivery updates appear here." />`}
    </div></div>`;
  };

  const Help = () => {
    const d = view(), t = T();
    if (!d) return null;
    const opts = [['missing', "My delivery hasn't arrived", 'box'], ['damaged', 'Package damaged or wrong', 'glass'], ['rider', 'Problem with the rider', 'user'], ['pin', 'Help with my PIN', 'lock']];
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="track" /><span class="mono cap">${d.id + ' · ' + d.vendor.name}</span></div>
      <h1 class="h-xl">What's wrong?</h1>
      <div class="card pad0">${opts.map(([k, l, ic]) => html`<button class="list-row" aria-pressed=${t.type === k ? 'true' : 'false'} onClick=${() => { t.type = k; D.rerender(); }} style=${t.type === k ? 'background:var(--pine-soft);margin:0 -16px;padding:8px 16px;width:calc(100% + 32px)' : ''}><${Icon} n=${ic} /><span class="grow t1">${l}</span>${t.type === k ? html`<${Icon} n="check" s="18" w="3" />` : html`<${Icon} n="chevR" s="16" c="#5F6C67" />`}</button>`)}</div>
      ${t.type === 'pin' ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Lost your PIN?</b><div class="cap">We'll send it again to ${d.recipient.phoneMasked}, the number on this delivery.</div><${Btn} kind="ink md" busy=${D.busy('c-pin')} onClick=${() => D.run('c-pin', () => call('recipient_resend_pin', {}), { dev, ok: 'PIN re-sent (see Messages)' })}>Resend my PIN<//></div>` : null}
      ${t.type && t.type !== 'pin' ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px"><label for="c-note" style="font-weight:700">Tell us more</label><textarea id="c-note" class="input" rows="3" placeholder=${t.type === 'damaged' ? 'What is damaged?' : 'What happened?'} value=${t.note || ''} onInput=${(e) => { t.note = e.target.value; }}></textarea>
        <${Btn} kind="ink md" busy=${D.busy('c-ticket')} onClick=${() => D.run('c-ticket', async () => { await call('recipient_open_ticket', { p_category: t.type, p_description: t.note || '' }); t.type = null; t.note = ''; }, { dev, ok: d.status === 'delivered' && t.type === 'damaged' ? 'Reported · ops will review the proof and contact the vendor' : 'Reported · support will follow up by SMS' })}>Send report<//></div>` : null}
      <div class="banner mari"><${Icon} n="alert" s="18" /><span>Drop Off staff will never ask for your PIN by phone. Only give it to your rider, in person, once you have the package.</span></div>
    </div></div>`;
  };

  D.RecipientApp = () => {
    if (!R.token && !['lookup'].includes(U.recipient.screen)) U.recipient.screen = 'lookup';
    if (R.token && !R.raw && !['verify', 'lookup'].includes(U.recipient.screen)) U.recipient.screen = 'verify';
    const map = { lookup: Lookup, verify: Verify, track: Track, driver: Driver, chat: Chat, proof: Proof, messages: Messages, help: Help };
    const C = map[U.recipient.screen] || Lookup;
    return html`<${C} />`;
  };
})();
