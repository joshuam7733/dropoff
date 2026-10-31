/* Drop Off — rider / driver app (dark, high-contrast). Acts as the signed-in rider; every step is a backend call. */
(function () {
  const D = window.DO, html = D.html, S = D.store, F = D.fmt, U = D.ui;
  const { Icon, VIcon, Chip, Progress, Btn, MapView, PhotoView, PhotoCapture, Avatar, Empty, PinPad, SignaturePad, SigView, Timeline } = D;
  const act = S.act;
  const dev = 'rider';
  const R = () => S.rider(S.me().riderId);
  const T = () => U.tmpOf.rider;
  const go = (s, p) => D.nav(dev, s, p);
  const seenOffers = new Map(); // delivery id → first time this device showed the request
  const dismissed = new Set();

  const Tabs = ({ cur }) => {
    const t = (id, label, icon) => html`<button aria-current=${cur === id ? 'page' : null} onClick=${() => D.home(dev, id)}><${Icon} n=${icon} s="24" c=${cur === id ? '#FFB71B' : 'currentColor'} />${label}</button>`;
    const jobs = availableJobs().length;
    const unread = S.state.notifications.filter((n) => n.aud === 'rider' && !n.read).length;
    return html`<nav class="tabbar" aria-label="Rider navigation">${t('home', 'Home', 'home')}<button aria-current=${cur === 'jobs' ? 'page' : null} onClick=${() => D.home(dev, 'jobs')}><${Icon} n="box" s="24" c=${cur === 'jobs' ? '#FFB71B' : 'currentColor'} />Jobs${jobs ? html`<span class="badge">${jobs}</span>` : null}</button>${t('earnings', 'Earnings', 'chart')}<button aria-current=${cur === 'profile' ? 'page' : null} onClick=${() => D.home(dev, 'profile')}><${Icon} n="user" s="24" c=${cur === 'profile' ? '#FFB71B' : 'currentColor'} />Account${unread ? html`<span class="badge">${unread}</span>` : null}</button></nav>`;
  };

  // Open requests the database lets this rider see (vehicle fits, not declined); RLS does the filtering.
  const availableJobs = () => S.state.deliveries.filter((d) => d.status === 'searching' && !d.declinedByMe);
  const earnOf = (d) => S.riderShare(d);
  const todayEarn = (r) => {
    const day = new Date().toDateString();
    return S.state.transactions.filter((t) => t.party === 'rider' && t.partyId === r.id && (t.type === 'earning' || t.type === 'deduction') && new Date(t.ts).toDateString() === day).reduce((s, t) => s + t.amount, 0);
  };
  const distTo = (r, p) => (r.loc ? S.geo.pathLen(S.geo.route(r.loc, p)) : null);

  const LocationNote = () => {
    const L = D.loc;
    if (L.state === 'on') return null;
    const msg = L.state === 'denied' ? L.error : L.state === 'unavailable' ? 'Location is not available on this device. Vendors and recipients will see estimates instead of your live position.' : L.state === 'asking' ? 'Waiting for your location…' : 'Location sharing is off.';
    return html`<div class="banner mari"><${Icon} n="pin" s="18" /><span>${msg}${L.state === 'off' || L.state === 'denied' ? html` <button class="linkbtn" style="padding:0;color:inherit;text-decoration:underline" onClick=${() => { D.loc.stop(); D.loc.start(); }}>Turn on</button>` : null}</span></div>`;
  };

  /* Direction to the next stop from the rider's live GPS fix. Turn-by-turn opens in the phone's maps app. */
  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const NavBanner = ({ d }) => {
    const toPickup = ['assigned', 'en_route_pickup', 'at_pickup'].includes(d.status);
    const dest = toPickup ? d.pickup : d.dropoff;
    const leg = d.leg;
    const r = R();
    const straight = leg && r.loc ? S.geo.distM(r.loc.lat, r.loc.lng, dest.lat, dest.lng) : null;
    const dir = leg && r.loc ? COMPASS[Math.round(S.geo.bearing(r.loc, dest) / 45) % 8] : null;
    return html`<div class="nav-banner" style=${leg ? '' : 'background:var(--d-surf);color:#fff'}>
      <span class="nav-arrow" style=${leg && r.loc ? 'transform:rotate(' + Math.round(S.geo.bearing(r.loc, dest)) + 'deg)' : ''}><${Icon} n=${leg ? 'arrowUp' : 'pin'} s="30" w="2.6" /></span>
      <div style="flex:1;min-width:0">${leg ? html`<div style="font-weight:700;font-size:21px;line-height:1.05">${straight < 60 ? 'You are there' : F.km(straight) + ' ' + dir}</div>
        <div style="font-weight:600;font-size:13px;margin-top:2px">${toPickup ? 'Pickup' : 'Drop-off'} · about ${F.mins(S.minsFor(leg.len, d.cls))} by road</div>`
        : html`<div style="font-size:14px">Turn on location for live distance. Head to <b>${dest.name}</b>.</div>`}</div>
      <a class="nav-go" href=${D.navUrl(dest)} target="_blank" rel="noopener" aria-label=${'Open directions to ' + dest.name + ' in your maps app'}><${Icon} n="nav" s="18" />Navigate</a></div>`;
  };

  /* ---------------- incoming request (newest open job this device hasn't dismissed) ---------------- */
  const Offer = ({ d, r }) => {
    const first = seenOffers.get(d.id);
    const left = Math.max(0, Math.ceil((first + 30000 - Date.now()) / 1000));
    const toPick = distTo(r, d.pickup);
    const C = 2 * Math.PI * 28;
    return html`<div class="overlay dark" style="background:rgba(0,0,0,.55)"><div class="sheet" style="gap:16px;color:#fff">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><div style="display:flex;gap:6px;align-items:center">${d.urgency === 'express' ? html`<span class="chip solid"><${Icon} n="bolt" s="12" />Express</span>` : html`<span class="chip" style="background:var(--d-surf);color:#fff">New request</span>`}<span class="cap">${(D.TYPES.find((t) => t.id === d.pkg.type) || {}).label} · ${(S.sizeOf(d.pkg.size) || {}).label} · ${d.pkg.weight} kg</span></div>
          <div class="tnum pop" style="font-weight:700;font-size:40px;margin-top:8px;line-height:1">${F.ugx(earnOf(d))}</div><div class="cap" style="margin-top:4px">Your earnings · fare ${F.ugx(d.price.total)}</div></div>
        <div style="position:relative;width:64px;height:64px;flex-shrink:0"><svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="none" stroke="#24463C" stroke-width="5" /><circle cx="32" cy="32" r="28" fill="none" stroke="#FFB71B" stroke-width="5" stroke-linecap="round" stroke-dasharray=${(C * left) / 30 + ' ' + C} transform="rotate(-90 32 32)" style="transition:stroke-dasharray 1s linear" /></svg><span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px" aria-live="polite">${left}s</span></div>
      </div>
      <div class="card" style="display:flex;gap:14px"><div style="display:flex;flex-direction:column;align-items:center;padding-top:5px"><span style="width:10px;height:10px;border-radius:50%;background:#fff"></span><span style="width:2px;flex:1;background:#3A5C51;margin:4px 0"></span><span style="width:10px;height:10px;border-radius:3px;background:var(--mari)"></span></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:12px"><div style="display:flex;justify-content:space-between;gap:8px"><div><b>${d.pickup.name}</b><div class="cap">${d.pickup.area}</div></div><span class="cap" style="text-align:right;white-space:nowrap">${toPick != null ? html`${F.km(toPick)}<br />${F.mins(S.minsFor(toPick, r.cls))}` : 'Distance needs GPS'}</span></div>
          <div style="display:flex;justify-content:space-between;gap:8px"><div><b>${d.dropoff.name}</b><div class="cap">${d.dropoff.area}</div></div><span class="cap" style="text-align:right;white-space:nowrap">${d.price.km} km<br />trip</span></div></div></div>
      <div class="pills">${d.pkg.fragile ? html`<span class="chip" style="background:var(--d-surf);color:#fff"><${Icon} n="glass" s="12" />Fragile</span>` : null}${d.pkg.upright ? html`<span class="chip" style="background:var(--d-surf);color:#fff"><${Icon} n="upright" s="12" />Keep upright</span>` : null}<span class="chip" style="background:var(--d-surf);color:#fff"><${Icon} n="lock" s="12" />PIN${d.sigRequired ? ' + signature' : ''}</span><span class="chip" style="background:var(--d-surf);color:#fff">Prepaid · no cash</span></div>
      <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px"><${Btn} kind="ghost" busy=${D.busy('r-decline')} onClick=${async () => { const ok = await D.run('r-decline', () => act.declineOffer(d.id, r.id, 'Declined by rider'), { dev, ok: 'Request declined' }); if (ok) dismissed.add(d.id); }}>Decline<//><${Btn} busy=${D.busy('r-accept')} label="Accepting…" onClick=${async () => { const ok = await D.run('r-accept', () => act.acceptOffer(d.id, r.id), { dev, ok: 'Job accepted · ' + d.id }); dismissed.add(d.id); if (ok) D.home(dev, 'active'); }}>Accept<//></div>
      <button class="linkbtn" style="color:var(--d-text2)" onClick=${() => { dismissed.add(d.id); D.rerender(); }}>Not now · keep it in Jobs</button>
    </div></div>`;
  };
  setInterval(() => { if (S.me() && S.me().role === 'rider' && seenOffers.size) D.rerender(); }, 1000);

  /* ---------------- home ---------------- */
  const Home = () => {
    const r = R();
    const job = r.activeId && S.delivery(r.activeId);
    const hot = availableJobs();
    return html`<div class="app dark">
      <div style="position:relative;flex:1;min-height:0"><${MapView} d=${job || null} focusRider=${r.id} extraPts=${hot.map((d) => d.pickup)} height=${520} dark=${true} label="Your location" />
        <div style="position:absolute;top:46px;left:16px;right:16px;display:flex;gap:10px;align-items:center">
          <button class="iconbtn" style="background:#E4EFEA;color:var(--ink);font-family:var(--f-display);font-weight:800" aria-label="Account" onClick=${() => D.home(dev, 'profile')}>${r.initials}</button>
          <button class="iconbtn" style="flex:1;border-radius:999px;width:auto;gap:8px;font-weight:700" onClick=${() => D.home(dev, 'earnings')}><span class="cap">Today</span><span class="tnum">${F.ugx(todayEarn(r))}</span></button>
          <button class="iconbtn" aria-label="Safety" onClick=${() => go('support')}><${Icon} n="shield" /></button></div>
        ${r.online && hot.length ? html`<button class="map-tag" style="left:16px;top:104px;background:var(--mari);color:var(--ink);border:0;cursor:pointer" onClick=${() => D.home(dev, 'jobs')}>${hot.length} request${hot.length === 1 ? '' : 's'} for your ${S.cls(r.cls).label.toLowerCase()}</button>` : null}</div>
      <div class="sheet" style="margin-bottom:82px;position:relative">
        <div class="grabber"></div>
        ${!r.verified ? html`<button class="banner mari" style="border:0;text-align:left;cursor:pointer" onClick=${() => go('verification')}><${Icon} n="clock" s="18" /><span><b>${D.VERIFY[r.verification].label}.</b> ${r.verification === 'pending' ? 'Verify your phone, add your ID details and upload your documents so ops can verify you.' : r.verification === 'rejected' ? 'Your application was not approved. See why.' : 'Ops is reviewing your documents. You can go online once verified.'}</span></button>` : null}
        ${r.online || job ? html`<${LocationNote} />` : null}
        <div style="display:flex;align-items:center;gap:12px">${r.online ? html`<span style="width:14px;height:14px;border-radius:50%;background:#3DD68C;box-shadow:0 0 0 6px rgba(61,214,140,.18)"></span>` : null}
          <div style="flex:1"><h1 class="h-lg">${r.online ? "You're online" : "You're offline"}</h1><div class="sub">${r.online ? (job ? 'On a job · ' + job.id : 'Waiting for ' + S.cls(r.cls).label.toLowerCase() + ' requests') : hot.length + ' open job' + (hot.length === 1 ? '' : 's') + ' fit your ' + S.cls(r.cls).label.toLowerCase()}</div></div></div>
        ${job ? html`<button class="card" style="display:flex;gap:12px;align-items:center;border:1px solid var(--mari);text-align:left;color:#fff" onClick=${() => D.home(dev, 'active')}><span class="ibox" style="background:var(--mari);color:var(--ink)"><${VIcon} c=${job.cls} /></span><span style="flex:1;min-width:0"><b>${D.STATUS[job.status].label} · ${job.id}</b><div class="cap">${job.pickup.area} → ${job.dropoff.area}</div></span><${Icon} n="chevR" /></button>` : null}
        ${r.online ? html`<${Btn} kind="ghost" busy=${D.busy('r-online')} disabled=${!!job} onClick=${() => D.run('r-online', () => act.setOnline(r.id, false), { dev, ok: 'You are offline. No new requests.' })}>${job ? 'Finish the job to go offline' : 'Go offline'}<//>`
          : html`<${Btn} busy=${D.busy('r-online')} label="Going online…" disabled=${!r.verified} onClick=${() => D.run('r-online', async () => { D.loc.start(); await act.setOnline(r.id, true); }, { dev, ok: 'You are online. Requests that fit your vehicle will appear here.' })}><${Icon} n="power" s="22" w="2.4" />Go online<//>`}
        <div class="row2" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="card" style="padding:10px 12px"><div class="cap">Trips</div><b>${F.num(r.trips)}</b></div><div class="card" style="padding:10px 12px"><div class="cap">Rating</div><b>★ ${r.rating.toFixed(2)}</b></div><div class="card" style="padding:10px 12px"><div class="cap">Acceptance</div><b>${r.acceptance}%</b></div></div>
      </div><${Tabs} cur="home" /></div>`;
  };

  /* ---------------- jobs ---------------- */
  const Jobs = () => {
    const r = R(), t = T();
    t.f = t.f || 'nearby';
    let jobs = availableJobs();
    if (t.f === 'express') jobs = jobs.filter((d) => d.urgency === 'express');
    if (t.f === 'pay') jobs = jobs.slice().sort((a, b) => earnOf(b) - earnOf(a));
    jobs = jobs.map((d) => ({ d, dist: distTo(r, d.pickup) }));
    if (t.f === 'nearby') jobs.sort((a, b) => (a.dist == null ? 1e9 : a.dist) - (b.dist == null ? 1e9 : b.dist) || b.d.createdAt - a.d.createdAt);
    return html`<div class="app dark"><div class="app-scroll with-tabs">
      <div><h1 class="h-xl">Jobs near you</h1><div class="sub">Only jobs that fit your ${S.cls(r.cls).label.toLowerCase()} · ${r.make} ${r.plate}</div></div>
      <div class="pills">${[['nearby', 'Nearby'], ['pay', 'Best pay'], ['express', 'Express']].map(([k, l]) => html`<button class="pill" aria-pressed=${t.f === k ? 'true' : 'false'} onClick=${() => { t.f = k; D.rerender(); }}>${l}</button>`)}<button class="pill" onClick=${() => go('history')}>Completed</button></div>
      ${!r.online ? html`<div class="banner mari"><${Icon} n="power" s="18" /><span>You're offline. Go online on Home to accept jobs.</span></div>` : null}
      ${r.activeId ? html`<div class="banner mari"><${Icon} n="box" s="18" /><span>Finish ${r.activeId} before taking another job.</span></div>` : null}
      ${jobs.map(({ d, dist }) => html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:center"><span style="display:flex;gap:6px;align-items:center">${d.urgency === 'express' ? html`<span class="chip solid">Express</span>` : null}<span class="cap">${(D.TYPES.find((x) => x.id === d.pkg.type) || {}).label} · ${d.pkg.weight} kg</span></span><b class="tnum" style="font-size:19px">${F.ugx(earnOf(d))}</b></div>
        <b>${d.pickup.area} → ${d.dropoff.area}</b>
        <div class="cap" style="display:flex;gap:12px;flex-wrap:wrap"><span>${dist != null ? F.km(dist) + ' to pickup' : 'Pickup: ' + d.pickup.name}</span><span>${d.price.km} km trip</span><span>${d.id}</span><span>${F.ago(d.createdAt)}</span></div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px"><${Btn} kind="ghost md" busy=${D.busy('r-dec' + d.id)} onClick=${() => D.run('r-dec' + d.id, () => act.declineOffer(d.id, r.id, 'Not interested'), { dev, ok: 'Hidden from your jobs' })}>Pass<//><${Btn} kind="md" disabled=${!r.online || !!r.activeId} busy=${D.busy('r-claim' + d.id)} label="Accepting…" onClick=${async () => { const ok = await D.run('r-claim' + d.id, () => act.claimJob(d.id, r.id), { dev, ok: 'Job accepted · ' + d.id }); if (ok) D.home(dev, 'active'); }}>Accept job<//></div></div>`)}
      ${!jobs.length ? html`<div class="card"><${Empty} icon="box" title="No open jobs right now" body="New requests that fit your vehicle appear here and as a pop-up while you are online." /></div>` : null}
    </div><${Tabs} cur="jobs" /></div>`;
  };

  /* ---------------- active job ---------------- */
  const Active = () => {
    const r = R(), t = T();
    const d = r.activeId && S.delivery(r.activeId);
    if (!d) {
      return html`<div class="app dark"><div class="app-scroll with-tabs"><h1 class="h-xl">No active job</h1><div class="card"><${Empty} icon="box" title="You're not on a delivery" body=${r.online ? 'Accept a request or pick one from Jobs.' : 'Go online to receive requests.'} action=${html`<button class="btn sm" onClick=${() => D.home(dev, r.online ? 'jobs' : 'home')}>${r.online ? 'See jobs' : 'Go to home'}</button>`} /></div></div><${Tabs} cur="home" /></div>`;
    }
    const st = d.status;
    const v = S.vendor(d.vendorId) || { name: 'the vendor' };
    const moving = ['assigned', 'en_route_pickup', 'in_transit', 'approaching'].includes(st);
    const legKm = d.leg ? F.km(d.leg.len) : null;
    const cancelBox = ['assigned', 'en_route_pickup', 'at_pickup'].includes(st) ? html`${t.cancel ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Why can't you do this job?</b><div class="pills">${['Vehicle problem', 'Too far', 'Package too large', 'Personal emergency'].map((x) => html`<button class="pill" aria-pressed=${t.reason === x ? 'true' : 'false'} onClick=${() => { t.reason = x; D.rerender(); }}>${x}</button>`)}</div>
        <${Btn} kind="danger md" disabled=${!t.reason} busy=${D.busy('r-cancel')} onClick=${async () => { const ok = await D.run('r-cancel', () => act.riderCancel(d.id, t.reason), { dev, ok: 'Job released · it goes back to matching' }); if (ok) D.home(dev, 'home'); }}>Release job<//></div>` : html`<button class="linkbtn" style="color:var(--d-text2)" onClick=${() => { t.cancel = true; D.rerender(); }}>Can't do this job?</button>`}` : null;
    const photoBusy = (k) => D.busy(k);
    let panel;
    if (st === 'assigned') {
      panel = html`<div><div class="eyebrow">Job confirmed · ${d.id}</div><h2 class="h-lg">Pick up at ${d.pickup.name}</h2><div class="sub">${legKm ? legKm + ' away · ' : ''}you earn ${F.ugx(earnOf(d))}</div></div>
        ${d.handover ? html`<div class="banner mari"><${Icon} n="users" s="18" /><span>Handover job: collect the package from ${d.handover.fromName || 'the previous driver'} at their location.</span></div>` : null}
        <div class="card pad0"><div class="kv"><span>Package</span><span>${d.pkg.desc}</span></div><div class="kv"><span>Size</span><span>${(S.sizeOf(d.pkg.size) || {}).label} · ${d.pkg.weight} kg${d.pkg.fragile ? ' · fragile' : ''}</span></div><div class="kv"><span>Drop-off</span><span>${d.dropoff.name}</span></div></div>
        ${d.pkg.photo ? html`<${PhotoView} photo=${d.pkg.photo} h=${120} label="Package photo from the vendor" />` : null}
        <${LocationNote} />
        <${Btn} busy=${D.busy('r-start')} label="Starting…" onClick=${() => D.run('r-start', () => act.startToPickup(d.id), { dev })}><${Icon} n="nav" s="20" />Start trip to pickup<//>${cancelBox}`;
    } else if (st === 'en_route_pickup') {
      panel = html`<div style="display:flex;align-items:center;gap:12px"><div style="flex:1"><div class="eyebrow">Pickup · ${d.id}</div><h2 class="h-md" style="font-size:21px">${d.pickup.name}</h2><div class="sub">${legKm ? F.mins(S.minsFor(d.leg.len, d.cls)) + ' · ' + legKm + ' · live GPS' : d.pickup.area}</div></div>
          <button class="iconbtn" aria-label="Call vendor" onClick=${() => D.run('r-callv', () => act.call(d.id, 'rider', 'vendor'), { dev, ok: 'Call request logged. Masked calling is not connected yet.' })}><${Icon} n="phone" /></button></div>
        <div class="pills"><span class="chip" style="background:var(--d-surf);color:#fff">${d.pkg.desc}</span>${d.pkg.upright ? html`<span class="chip" style="background:var(--d-surf);color:#fff">Keep upright</span>` : null}<span class="chip" style="background:var(--d-surf);color:#fff">Earn ${F.ugx(earnOf(d))}</span></div>
        <${Btn} busy=${D.busy('r-arrive')} onClick=${() => D.run('r-arrive', () => act.arriveAtPickup(d.id), { dev })}>I've arrived at pickup<//>${cancelBox}`;
    } else if (st === 'at_pickup') {
      t.pin = t.pin || '';
      panel = html`<div><div class="eyebrow">At ${d.pickup.area} · ${d.id}</div><h2 class="h-lg">Confirm the pickup</h2></div>
        <div class="card pad0"><button class="list-row" onClick=${() => { t.label = !t.label; D.rerender(); }}><span class="ibox" style=${t.label ? 'background:var(--mari);color:var(--ink)' : ''}><${Icon} n="check" s="16" w="3" /></span><span class="grow"><span class="t1" style="display:block">Label shows ${d.id}</span><span class="t2">${d.pkg.desc}</span></span></button></div>
        <div class="field"><span class="lbl">Photo of the package</span><${PhotoCapture} id="r-pphoto" photo=${d.proof.pickup.photo} busy=${photoBusy('r-photo')} dark=${true} label="Pickup photo" onPhoto=${(p) => D.run('r-photo', () => act.setPhoto(d.id, 'pickup', p), { dev, ok: 'Pickup photo saved' })} /></div>
        ${d.handover ? html`<div class="banner mari">Handover: no vendor PIN needed. The photo and GPS record the handover.</div>` : html`<div class="field"><span class="lbl">Pickup PIN from ${v.name}</span><div class="cap">The vendor sees it on their tracking screen.</div><${PinPad} value=${t.pin} get=${() => T().pin} dark=${true} state=${t.pinState} onChange=${(x) => { T().pin = x; T().pinState = null; D.rerender(); }} /></div>`}
        <${Btn} busy=${D.busy('r-pick')} label="Confirming…" disabled=${!d.proof.pickup.photo || (!d.handover && t.pin.length !== 4)} onClick=${async () => { const ok = await D.run('r-pick', () => act.confirmPickup(d.id, t.pin), { dev, ok: 'Pickup confirmed · time and GPS recorded' }); if (!ok) { t.pinState = 'bad'; t.pin = ''; D.rerender(); } }}>Confirm pickup<//>${cancelBox}`;
    } else if (st === 'picked_up') {
      panel = html`<div class="pop" style="display:flex;gap:12px;align-items:center"><span style="width:48px;height:48px;border-radius:50%;background:var(--mari);color:var(--ink);display:flex;align-items:center;justify-content:center"><${Icon} n="check" s="26" w="2.8" /></span><div><h2 class="h-lg">Package on board</h2><div class="sub">Picked up ${d.proof.pickup.ts ? F.time(d.proof.pickup.ts) : ''} · photo saved</div></div></div>
        <div class="card pad0"><div class="kv"><span>Deliver to</span><span>${d.recipient.name}</span></div><div class="kv"><span>Address</span><span>${d.dropoff.name}</span></div>${d.recipient.notes ? html`<div class="kv"><span>Notes</span><span>${d.recipient.notes}</span></div>` : null}</div>
        <${Btn} busy=${D.busy('r-go')} onClick=${() => D.run('r-go', () => act.startDelivery(d.id), { dev, ok: 'Delivery started · vendor and recipient can follow you' })}><${Icon} n="nav" s="20" />Start delivery<//>`;
    } else if (st === 'in_transit' || st === 'approaching') {
      const unreadChat = d.chat.some((m) => m.from === 'recipient' && m.ts > (t.seen || 0));
      panel = html`<${Progress} status=${st} /><div style="display:flex;align-items:center;gap:12px"><div style="flex:1;min-width:0"><div class="eyebrow">Deliver to</div><h2 class="h-md" style="font-size:21px">${d.recipient.name}</h2><div class="sub">${d.dropoff.name}</div></div>
          <button class="iconbtn" style="background:var(--mari);color:var(--ink)" aria-label="Call recipient" onClick=${() => D.run('r-callr', () => act.call(d.id, 'rider', 'recipient'), { dev, ok: 'Call request logged. Masked calling is not connected yet; message them instead.' })}><${Icon} n="phone" /></button>
          <button class="iconbtn" aria-label="Message recipient" onClick=${() => go('chat', { id: d.id })}><${Icon} n="msg" />${unreadChat ? html`<span class="dot"></span>` : null}</button></div>
        ${d.recipient.notes ? html`<div class="banner mari"><${Icon} n="msg" s="18" /><span>“${d.recipient.notes}”</span></div>` : null}
        <${Btn} busy=${D.busy('r-arr')} onClick=${() => D.run('r-arr', () => act.arriveAtDropoff(d.id), { dev })}>I've arrived at the drop-off<//>
        <div style="display:flex;justify-content:space-between">${st === 'in_transit' ? html`<button class="linkbtn" style="color:var(--d-text2)" onClick=${() => D.run('r-near', () => act.markApproaching(d.id), { dev, ok: 'Recipient told you are a few minutes away' })}>Tell the recipient I'm close</button>` : html`<span></span>`}<button class="linkbtn" style="color:var(--d-text2)" onClick=${() => D.run('r-veh', () => act.reportVehicleIssue(d.id), { dev, ok: 'Ops alerted · they will arrange a handover' })}>Vehicle problem</button></div>`;
    } else if (st === 'arrived' || st === 'awaiting_confirmation') {
      t.pin = t.pin || '';
      const p = d.proof.drop;
      const un = d.unreachable;
      const waitMin = +(S.state.settings.unreachable_wait_min || 10);
      const waited = un ? (Date.now() - un.startReal) / 60000 : 0;
      const unBox = un ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px;border:1px solid #5C4A10"><b>Recipient not available</b><div class="cap">Calls logged: ${un.calls} of 3 · waited ${Math.floor(waited)} of ${waitMin} min</div>
        <div class="row2"><${Btn} kind="soft md" onClick=${() => D.run('r-callr2', () => act.call(d.id, 'rider', 'recipient'), { dev, ok: 'Call logged' })}><${Icon} n="phone" s="16" />Log a call<//><${Btn} kind="danger md" disabled=${un.calls < 3 || waited < waitMin} busy=${D.busy('r-fail')} onClick=${async () => { const ok = await D.run('r-fail', () => act.markFailed(d.id, 'Recipient unreachable after ' + un.calls + ' calls'), { dev, ok: 'Marked as failed · vendor decides next step' }); if (ok) D.home(dev, 'home'); }}>Mark failed<//></div></div>`
        : html`<button class="linkbtn" style="color:var(--d-text2)" onClick=${() => D.run('r-unr', () => act.reportUnreachable(d.id), { dev, ok: 'Waiting timer started · call the recipient' })}>Recipient not available?</button>`;
      if (st === 'arrived') {
        panel = html`<div><div class="eyebrow">At the drop-off · ${d.id}</div><h2 class="h-lg">Hand over to ${F.first(d.recipient.name)}</h2><div class="sub">Check it's the right person, give them the package, then ask for their 4-digit PIN.</div></div>
          <${Btn} busy=${D.busy('r-hand')} onClick=${() => D.run('r-hand', () => act.startHandoff(d.id), { dev })}>Start handover<//>
          <div class="row2"><${Btn} kind="soft md" onClick=${() => D.run('r-callr', () => act.call(d.id, 'rider', 'recipient'), { dev, ok: 'Call request logged' })}><${Icon} n="phone" s="16" />Call<//><${Btn} kind="soft md" onClick=${() => go('chat', { id: d.id })}><${Icon} n="msg" s="16" />Message<//></div>${unBox}`;
      } else {
        const ready = p.pinOk && p.photo && (!d.sigRequired || p.signature) && (p.receivedBy !== 'other' || (p.receiverName || '').trim().length >= 2);
        panel = html`<div><div class="eyebrow">Proof of delivery · ${d.id}</div><h2 class="h-lg">Hand over & prove it</h2></div>
          <div class="card" style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between"><b>1 · Recipient's PIN</b><span class="cap">${p.pinOk ? 'Confirmed' + (p.pinBy === 'recipient' ? ' by the recipient' : '') : 'In their SMS'}</span></div>
            ${p.pinOk ? html`<div class="banner info pop"><${Icon} n="check" s="18" /><span>PIN confirmed${p.pinBy === 'recipient' ? ' on the recipient\'s phone' : ''}.</span></div>` : html`<${PinPad} value=${t.pin} get=${() => T().pin} dark=${true} state=${t.pinState} onChange=${(x) => { T().pin = x; T().pinState = null; D.rerender(); }} />
            <${Btn} kind="md" disabled=${t.pin.length !== 4} busy=${D.busy('r-pin')} label="Checking…" onClick=${async () => { const ok = await D.run('r-pin', () => act.submitDeliveryPin(d.id, t.pin), { dev, ok: 'PIN matches' }); if (!ok) { t.pinState = 'bad'; t.pin = ''; D.rerender(); } }}>Check PIN<//>
            <div class="cap">The recipient can also confirm the PIN on their tracking page.</div>`}</div>
          <div class="card" style="display:flex;flex-direction:column;gap:10px"><b>2 · Handover photo</b><${PhotoCapture} id="r-dphoto" photo=${p.photo} busy=${photoBusy('r-dph')} dark=${true} label="Delivery photo" onPhoto=${(ph) => D.run('r-dph', () => act.setPhoto(d.id, 'drop', ph), { dev, ok: 'Delivery photo saved' })} /></div>
          <div class="card" style="display:flex;flex-direction:column;gap:10px"><b>3 · Received by</b><div class="row2"><button class="pill" style="justify-content:center;height:42px" aria-pressed=${p.receivedBy === 'recipient' ? 'true' : 'false'} onClick=${() => D.run('r-recv', () => act.setReceiver(d.id, 'recipient'), { dev })}>${F.first(d.recipient.name)}</button><button class="pill" style="justify-content:center;height:42px" aria-pressed=${p.receivedBy === 'other' ? 'true' : 'false'} onClick=${() => D.run('r-recv', () => act.setReceiver(d.id, 'other', t.rname || p.receiverName), { dev })}>Someone else</button></div>
            ${p.receivedBy === 'other' ? html`<input class="input" aria-label="Name of the person who received it" placeholder="Their full name" value=${t.rname != null ? t.rname : p.receiverName} onInput=${(e) => { t.rname = e.target.value; }} onBlur=${() => D.run('r-recv', () => act.setReceiver(d.id, 'other', t.rname), { dev })} />` : null}</div>
          ${d.sigRequired ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px;color:var(--ink);background:#fff"><b>4 · Signature <span class="cap">(required)</span></b>${p.signature && !t.sigEdit ? html`<${SigView} value=${p.signature} /><button class="linkbtn" style="align-self:flex-start;padding:0" onClick=${() => { t.sigEdit = true; D.rerender(); }}>Sign again</button>` : html`<${SignaturePad} value=${t.sig} onChange=${(data) => { T().sig = data; D.rerender(); }} /><${Btn} kind="ink md" disabled=${!t.sig} busy=${D.busy('r-sig')} onClick=${() => D.run('r-sig', async () => { await act.setSignature(d.id, t.sig); t.sigEdit = false; }, { dev, ok: 'Signature saved' })}>Save signature<//>`}</div>` : null}
          <${Btn} busy=${D.busy('r-done')} label="Completing…" disabled=${!ready} onClick=${async () => { const ok = await D.run('r-done', () => act.completeDelivery(d.id), { dev }); if (ok) D.home(dev, 'done', { id: d.id }); }}>Complete delivery<//>${unBox}`;
      }
    }
    return html`<div class="app dark">
      <div style="position:relative;flex-shrink:0">${moving ? html`<${MapView} d=${d} height=${330} dark=${true} label=${'Navigation map for ' + d.id} />` : html`<div style="height:46px"></div>`}
        ${moving && st !== 'assigned' ? html`<${NavBanner} d=${d} />` : html`<div style=${'position:absolute;top:' + (moving ? 46 : 0) + 'px;left:16px'}><button class="iconbtn" aria-label="Home" onClick=${() => D.home(dev, 'home')}><${Icon} n="chevL" s="22" /></button></div>`}
      </div>
      <div class="app-scroll" style=${'padding-top:' + (moving ? 16 : 10) + 'px;padding-bottom:100px;' + (moving ? 'margin-top:-20px;border-radius:24px 24px 0 0;background:var(--d-bg);position:relative' : '')}>${panel}</div>
      <${Tabs} cur="home" /></div>`;
  };

  const Chat = () => {
    const d = S.delivery(U.rider.params.id), t = T();
    if (!d) return null;
    t.seen = Date.now();
    return html`<div class="app dark"><div class="app-scroll" style="gap:10px">
      <div class="hdr"><${D.Back} dev=${dev} fallback="active" /><div style="flex:1"><b>${d.recipient.name}</b><div class="cap">Recipient · they reply from their tracking page</div></div></div>
      <div class="cap" style="text-align:center">Messages are kept for support and safety. They also reach the recipient by SMS.</div>
      ${d.chat.map((m) => html`<div class=${'bubble ' + (m.from === 'rider' ? 'me' : 'them')} style=${m.from === 'rider' ? 'background:var(--mari);color:var(--ink)' : 'background:var(--d-surf);color:#fff'}>${m.text}<div class="ts">${F.time(m.ts)}</div></div>`)}
      ${!d.chat.length ? html`<div class="empty" style="color:var(--d-muted)">No messages yet.</div>` : null}
      <div class="pills">${["I'm outside", 'Arriving in 5 min', 'Which gate?'].map((q) => html`<button class="pill" onClick=${() => D.run('r-msg', () => act.sendChat(d.id, 'rider', q), { dev })}>${q}</button>`)}</div>
    </div><div class="app-bottom" style="flex-direction:row;align-items:center"><input class="input" aria-label="Message" placeholder="Message" value=${t.msg || ''} onInput=${(e) => { t.msg = e.target.value; D.rerender(); }} style="height:48px;border-radius:999px" /><button class="iconbtn" style="background:var(--mari);color:var(--ink)" aria-label="Send" onClick=${() => D.run('r-msg', async () => { await act.sendChat(d.id, 'rider', t.msg); t.msg = ''; }, { dev })}><${Icon} n="send" /></button></div></div>`;
  };

  const Done = () => {
    const d = S.delivery(U.rider.params.id);
    const r = R();
    if (!d) return null;
    const ok = d.status === 'delivered';
    return html`<div class="app dark"><div class="app-scroll" style="padding-top:90px;gap:18px">
      <div class="pop" style="align-self:center;width:108px;height:108px;border-radius:50%;background:var(--mari);color:var(--ink);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 14px rgba(255,183,27,.12),0 0 0 30px rgba(255,183,27,.06)"><${Icon} n=${ok ? 'check' : 'alert'} s="54" w="2.6" /></div>
      <div style="text-align:center"><h1 class="h-xl" style="font-size:34px">${ok ? 'Delivered' : D.STATUS[d.status].label}</h1><div class="sub">${d.pickup.area} → ${d.recipient.name} · ${F.time(d.statusAt)}</div></div>
      ${ok ? html`<div class="card" style="text-align:center"><div class="cap">You earned</div><div class="tnum count-up" style="font-weight:700;font-size:42px;color:var(--mari)">${F.ugx(d.earning)}</div><div class="cap">Added to your balance · ${F.ugx(r.balance)} available</div></div>` : null}
      <div class="row2" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="card" style="text-align:center;padding:10px"><div class="cap">Today</div><b class="tnum">${F.k(todayEarn(r))}</b></div><div class="card" style="text-align:center;padding:10px"><div class="cap">Trips</div><b>${F.num(r.trips)}</b></div><div class="card" style="text-align:center;padding:10px"><div class="cap">Open jobs</div><b>${availableJobs().length}</b></div></div>
    </div><div class="app-bottom"><${Btn} onClick=${() => D.home(dev, 'jobs')}>Find next delivery<//><${Btn} kind="soft" onClick=${() => D.home(dev, 'home')}>Back to home<//></div></div>`;
  };

  /* ---------------- earnings, payouts, history ---------------- */
  const Earnings = () => {
    const r = R();
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) { const x = new Date(now); x.setDate(x.getDate() - i); days.push(x); }
    const txs = S.state.transactions.filter((t) => t.party === 'rider' && t.partyId === r.id);
    const vals = days.map((day) => txs.filter((t) => (t.type === 'earning' || t.type === 'deduction') && new Date(t.ts).toDateString() === day.toDateString()).reduce((s, t) => s + t.amount, 0));
    const total = vals.reduce((a, b) => a + b, 0);
    const max = Math.max(10000, ...vals);
    const top = Math.ceil(max / 20000) * 20000;
    const trips = S.state.deliveries.filter((d) => d.riderId === r.id && d.status === 'delivered' && Date.now() - d.statusAt < 7 * 864e5).length;
    const pending = S.state.deliveries.filter((d) => d.riderId === r.id && D.ACTIVE.includes(d.status)).reduce((s, d) => s + earnOf(d), 0);
    return html`<div class="app dark"><div class="app-scroll with-tabs">
      <h1 class="h-xl">Earnings</h1>
      <div class="card" style="display:flex;flex-direction:column;gap:12px">
        <div><div class="cap">Last 7 days</div><div class="tnum" style="font-weight:700;font-size:40px;line-height:1.05">${F.ugx(total)}</div></div>
        <svg viewBox="0 0 340 170" width="100%" role="img" aria-label=${'Daily earnings for the last 7 days, total ' + F.ugx(total)}>
          ${[0, 0.5, 1].map((f) => html`<line x1="34" x2="340" y1=${140 - 120 * f} y2=${140 - 120 * f} stroke="#24463C" /><text x="0" y=${144 - 120 * f} font-size="10" fill="#93A79F" font-family="Onest">${F.k(top * f)}</text>`)}
          ${vals.map((v, i) => { const hh = Math.max(0, (v / top) * 120); const x = 44 + i * 42; const today = i === 6; return html`<g><title>${days[i].toDateString() + ' · ' + F.ugx(v)}</title>${hh > 0 ? html`<path d=${'M' + x + ' 140V' + (140 - hh + 4) + 'Q' + x + ' ' + (140 - hh) + ' ' + (x + 4) + ' ' + (140 - hh) + 'H' + (x + 18) + 'Q' + (x + 22) + ' ' + (140 - hh) + ' ' + (x + 22) + ' ' + (140 - hh + 4) + 'V140Z'} fill="#FFB71B" fill-opacity=${today ? 0.55 : 1} />` : null}<text x=${x + 11} y="158" text-anchor="middle" font-size="10" fill=${today ? '#fff' : '#93A79F'} font-weight=${today ? 700 : 400} font-family="Onest">${today ? 'Today' : days[i].toLocaleDateString('en-US', { weekday: 'short' })}</text></g>`; })}
        </svg>
      </div>
      <div class="row2" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="card" style="padding:10px 12px"><div class="cap">Deliveries</div><b>${trips}</b></div><div class="card" style="padding:10px 12px"><div class="cap">Pending</div><b class="tnum">${F.k(pending)}</b></div><div class="card" style="padding:10px 12px"><div class="cap">Commission</div><b>${(S.state.pricing[r.cls] || {}).commission || 0}%</b></div></div>
      <button class="btn" style="justify-content:space-between;padding:0 8px 0 20px" onClick=${() => go('payouts')}><span>${F.ugx(r.balance)} ready to cash out</span><span class="btn sm ink" style="pointer-events:none">Cash out</span></button>
      <div class="eyebrow">Recent</div>
      <div class="card pad0" style="margin-top:-6px">${txs.slice(0, 15).map((t) => html`<div class="list-row"><span class="grow"><span class="t1" style="display:block;font-size:14px">${t.label}</span><span class="t2">${F.dayTime(t.ts)}</span></span><b class="tnum" style=${t.amount > 0 ? 'color:#7FD3A5' : ''}>${t.amount > 0 ? '+' : '−'}${F.num(Math.abs(t.amount))}</b></div>`)}${!txs.length ? html`<div class="empty" style="color:var(--d-muted)">Earnings appear here after your first delivery.</div>` : null}</div>
    </div><${Tabs} cur="earnings" /></div>`;
  };

  const Payouts = () => {
    const r = R();
    return html`<div class="app dark"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="earnings" /><h1>Cash out</h1></div>
      <${D.CashOut} dev=${dev} dark=${true} balance=${r.balance} verified=${r.verified} verifyHint="Cash-out opens once ops verify your documents." />
    </div></div>`;
  };

  const History = () => {
    const r = R(), t = T();
    t.f = t.f || 'all';
    const mine = S.state.deliveries.filter((d) => d.riderId === r.id && !D.ACTIVE.includes(d.status));
    const list = mine.filter((d) => t.f === 'all' || (t.f === 'delivered' ? ['delivered', 'disputed'].includes(d.status) : d.status === t.f));
    return html`<div class="app dark"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="jobs" /><h1>My deliveries</h1></div>
      <div class="pills">${[['all', 'All'], ['delivered', 'Delivered'], ['failed', 'Failed'], ['cancelled', 'Cancelled']].map(([k, l]) => html`<button class="pill" aria-pressed=${t.f === k ? 'true' : 'false'} onClick=${() => { t.f = k; D.rerender(); }}>${l}</button>`)}</div>
      <div class="card pad0">${list.map((d) => html`<button class="list-row" onClick=${() => { t.open = t.open === d.id ? null : d.id; D.rerender(); }} style="flex-direction:column;align-items:stretch">
        <span style="display:flex;gap:12px;align-items:center"><span class="cap" style="width:70px">${F.day(d.statusAt)}</span><span class="grow"><span class="t1" style="display:block;font-size:14px">${d.pickup.area} → ${d.dropoff.area}</span><span class="t2">${d.id} · ${D.STATUS[d.status].label}</span></span><b class="tnum">${d.earning ? F.num(d.earning) : '—'}</b></span>
        ${t.open === d.id ? html`<div style="padding-top:10px"><${Timeline} events=${d.events.filter((e) => !e.actor || e.actor.role !== 'vendor')} dark=${true} max=${10} /></div>` : null}</button>`)}
        ${!list.length ? html`<div class="empty" style="color:var(--d-muted)">No deliveries in this filter.</div>` : null}</div>
    </div></div>`;
  };

  /* ---------------- profile, verification, vehicle, support ---------------- */
  const Profile = () => {
    const r = R(), me = S.me();
    const unread = S.state.notifications.filter((n) => n.aud === 'rider' && !n.read).length;
    return html`<div class="app dark"><div class="app-scroll with-tabs">
      <div class="hdr"><span style="border:3px solid var(--mari);border-radius:50%"><${Avatar} name=${r.name} s="60" /></span><div style="flex:1;min-width:0"><h1>${r.name}</h1><div class="cap">${r.cls ? S.cls(r.cls).label : 'No vehicle'} · since ${r.since} · ${D.VERIFY[r.verification].label}</div><div class="cap" style="overflow:hidden;text-overflow:ellipsis">${me.email}</div></div></div>
      <div class="card" style="display:flex;flex-direction:column;gap:12px"><div style="display:flex;gap:12px;align-items:center"><span class="ibox" style="background:var(--mari);color:var(--ink);width:50px;height:50px"><${VIcon} c=${r.cls || 'boda'} s="30" /></span><div style="flex:1"><b>${r.make}${r.color ? ' · ' + r.color : ''}</b><div class="cap">${r.cls ? S.cls(r.cls).label + ' · up to ' + F.num(S.cls(r.cls).maxKg) + ' kg' : 'Add your vehicle'}</div></div><span class="mono" style="background:#fff;color:var(--ink);padding:5px 7px;border-radius:6px;font-size:12px">${r.plate}</span></div>
        <div class="kv"><span>Driving permit</span><span>${r.licenseNo || '—'}</span></div><div class="kv"><span>Verification</span><span>${D.VERIFY[r.verification].label}</span></div><div class="kv"><span>Balance</span><span>${F.ugx(r.balance)}</span></div></div>
      <div class="card pad0">
        <button class="list-row" onClick=${() => go('verification')}><${Icon} n="shield" /><span class="grow"><span class="t1" style="display:block">Verification & vehicle</span><span class="t2">${D.VERIFY[r.verification].label}</span></span><${Icon} n="chevR" s="16" /></button>
        <button class="list-row" onClick=${() => go('notifications')}><${Icon} n="bell" /><span class="grow"><span class="t1" style="display:block">Notifications</span><span class="t2">${unread ? unread + ' unread' : 'All caught up'}</span></span><${Icon} n="chevR" s="16" /></button>
        <button class="list-row" onClick=${() => go('history')}><${Icon} n="clock" /><span class="grow t1">My deliveries</span><${Icon} n="chevR" s="16" /></button>
        <button class="list-row" onClick=${() => go('payouts')}><${Icon} n="wallet" /><span class="grow"><span class="t1" style="display:block">Cash out</span><span class="t2">${me.phoneVerified ? F.phoneMask(me.phone) : 'Verify your phone first'}</span></span><${Icon} n="chevR" s="16" /></button>
        <button class="list-row" onClick=${() => go('support')}><${Icon} n="help" /><span class="grow t1">Support & safety</span><${Icon} n="chevR" s="16" /></button>
      </div>
      <${Btn} kind="ghost md" busy=${D.busy('signout')} disabled=${!!r.activeId} onClick=${() => D.run('signout', async () => { if (r.online) await act.setOnline(r.id, false); await D.api.signOut(); }, { dev: 'global' })}>${r.activeId ? 'Finish your job to sign out' : 'Sign out'}<//>
    </div><${Tabs} cur="profile" /></div>`;
  };

  let markedAt = 0;
  const Notifications = () => {
    const list = S.state.notifications.filter((n) => n.aud === 'rider');
    if (list.some((n) => !n.read) && Date.now() - markedAt > 5000) { markedAt = Date.now(); setTimeout(() => act.markRead().catch(() => {}), 1500); }
    return html`<div class="app dark"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="profile" /><h1>Notifications</h1></div>
      <div class="card pad0">${list.slice(0, 60).map((n) => html`<button class="list-row" style="align-items:flex-start" onClick=${() => n.did && S.delivery(n.did) && S.delivery(n.did).riderId === R().id && D.ACTIVE.includes(S.delivery(n.did).status) ? D.home(dev, 'active') : n.kind === 'offer' ? D.home(dev, 'jobs') : null}>
        <${Icon} n=${n.kind === 'money' ? 'wallet' : n.kind === 'bad' ? 'alert' : n.kind === 'offer' ? 'box' : 'bell'} /><span class="grow"><span style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:14px">${n.title}</b><span class="cap" style="white-space:nowrap">${F.dayTime(n.ts)}</span></span><span class="t2" style="display:block">${n.body}</span></span>${!n.read ? html`<span style="width:8px;height:8px;border-radius:50%;background:var(--mari);margin-top:6px;flex-shrink:0"></span>` : null}</button>`)}
        ${!list.length ? html`<div class="empty" style="color:var(--d-muted)">No notifications yet.</div>` : null}</div>
    </div></div>`;
  };

  const Verification = () => {
    const r = R(), t = T();
    const veh = r.vehicle || {};
    const editable = !['verified', 'under_review'].includes(r.verification) && !(r.verification === 'submitted');
    if (t.vinit !== r.id) Object.assign(t, { vinit: r.id, cls: veh.cls || 'boda', make: veh.make || '', color: veh.color || '', plate: veh.plate || '', vreg: veh.registrationNo || '', license: r.licenseNo || '' });
    return html`<div class="app dark"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="profile" /><h1>Verification</h1></div>
      <div class="sub">Ops checks everything by hand before you can go online: your phone, ID details, a selfie, your National ID, driving permit and vehicle logbook.</div>
      <div class="eyebrow">1 · Phone</div><${D.PhoneVerify} dev=${dev} dark=${true} />
      <div class="eyebrow">2 · ID details</div><${D.KycPanel} dev=${dev} dark=${true} locked=${['under_review', 'verified'].includes(r.verification)} />
      <div class="eyebrow">3 · Documents</div>
      <${D.VerificationPanel} kinds=${['national_id', 'selfie', 'driving_permit', 'vehicle_logbook', 'insurance']} required=${['national_id', 'selfie', 'driving_permit', 'vehicle_logbook']} devName="rider" />
      <div class="eyebrow">Vehicle</div>
      ${editable ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
        <div class="pills">${D.CLASS_ORDER.map((c) => html`<button class="pill" aria-pressed=${t.cls === c ? 'true' : 'false'} onClick=${() => { t.cls = c; D.rerender(); }}><${VIcon} c=${c} s="16" />${S.cls(c).label}</button>`)}</div>
        <div class="row2"><div class="field"><label for="vh-make">Make & model</label><input id="vh-make" class="input" value=${t.make} onInput=${(e) => { t.make = e.target.value; }} /></div><div class="field"><label for="vh-color">Colour</label><input id="vh-color" class="input" value=${t.color} onInput=${(e) => { t.color = e.target.value; }} /></div></div>
        <div class="row2"><div class="field"><label for="vh-plate">Plate</label><input id="vh-plate" class="input mono" value=${t.plate} onInput=${(e) => { t.plate = e.target.value; }} /></div><div class="field"><label for="vh-lic">Driving permit no.</label><input id="vh-lic" class="input" value=${t.license} onInput=${(e) => { t.license = e.target.value; }} /></div></div>
        <${Btn} kind="md" busy=${D.busy('r-veh-save')} onClick=${() => D.run('r-veh-save', () => act.updateVehicle({ class_id: t.cls, make: t.make, color: t.color, plate: t.plate, registration_no: t.vreg, license_no: t.license }), { dev, ok: 'Vehicle saved' })}>Save vehicle<//></div>`
        : html`<div class="card pad0"><div class="kv"><span>Vehicle</span><span>${S.cls(veh.cls).label} · ${veh.make} · ${veh.color}</span></div><div class="kv"><span>Plate</span><span class="mono">${veh.plate}</span></div><div class="kv"><span>Status</span><span>${D.VERIFY[veh.verification || 'pending'].label}</span></div><div class="cap" style="padding:10px 0">Contact support to change a vehicle that is being reviewed or already verified.</div></div>`}
    </div></div>`;
  };

  const Support = () => {
    const r = R(), t = T();
    const d = r.activeId && S.delivery(r.activeId);
    const tickets = S.state.tickets.filter((x) => x.riderId === r.id);
    return html`<div class="app dark"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="profile" /><h1>Support & safety</h1></div>
      <button style="border:0;border-radius:22px;background:#B42A20;color:#fff;padding:16px;display:flex;gap:14px;align-items:center;text-align:left" onClick=${() => D.run('r-sos', () => act.sos(d ? d.id : null), { dev, ok: 'Ops safety desk alerted' + (D.loc.state === 'on' ? ' with your location' : '') })}>
        <span style="width:54px;height:54px;border-radius:50%;background:#fff;color:#B42A20;display:flex;align-items:center;justify-content:center;font-weight:800">SOS</span><span><b style="font-size:17px;display:block">Emergency</b><span style="font-size:13px;color:#FFE1DE">Alerts the Drop Off ops desk${D.loc.state === 'on' ? ' with your location' : ''}. In danger, call 999 first.</span></span></button>
      <div class="card" style="display:flex;flex-direction:column;gap:10px"><b>${d ? 'Problem with ' + d.id : 'Report a problem'}</b><div class="pills">${(d ? [['damaged', 'Package damaged'], ['address', 'Address wrong'], ['rider', 'Vendor or recipient issue'], ['other', 'Other']] : [['payment', 'Payments'], ['other', 'Other']]).map(([k, l]) => html`<button class="pill" aria-pressed=${t.type === k ? 'true' : 'false'} onClick=${() => { t.type = k; D.rerender(); }}>${l}</button>`)}</div>
        <textarea class="input" rows="2" aria-label="Describe the problem" placeholder="What happened?" value=${t.note || ''} onInput=${(e) => { t.note = e.target.value; }}></textarea>
        <${Btn} kind="md" busy=${D.busy('r-tk')} onClick=${() => D.run('r-tk', async () => { if (!t.type) throw new D.UserError('Choose what went wrong.'); await act.openTicket({ did: d ? d.id : null, type: t.type, note: t.note }); t.type = null; t.note = ''; }, { dev, ok: 'Ops has your report' })}>Send to ops<//></div>
      <div class="eyebrow">Your cases</div>
      <div class="card pad0" style="margin-top:-6px">${tickets.map((x) => html`<div class="list-row"><span class="grow"><span class="t1" style="display:block;font-size:14px">${x.title}${x.did ? ' · ' + x.did : ''}</span><span class="t2">${x.id} · ${F.dayTime(x.createdAt)}${x.resolutionNote ? ' · ' + x.resolutionNote : ''}</span></span><span class=${'chip ' + (['resolved', 'closed'].includes(x.status) ? 'ok' : 'mari')}>${D.TICKET[x.status]}</span></div>`)}${!tickets.length ? html`<div class="empty" style="color:var(--d-muted)">No cases yet.</div>` : null}</div>
    </div></div>`;
  };

  D.RiderApp = () => {
    const r = R();
    if (!r) return html`<div class="app dark"><div class="app-scroll"><${Empty} title="No rider profile" body="This account isn't linked to a rider profile. Contact support." /></div></div>`;
    // share GPS while online or on a job; stop otherwise
    if ((r.online || r.activeId) && D.loc.state === 'off') D.loc.start();
    if (!r.online && !r.activeId && D.loc.state === 'on') D.loc.stop();
    let offerD = null;
    if (r.online && !r.activeId) {
      offerD = availableJobs().filter((d) => !dismissed.has(d.id)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
      if (offerD) {
        if (!seenOffers.has(offerD.id)) seenOffers.set(offerD.id, Date.now());
        if (Date.now() - seenOffers.get(offerD.id) > 30000) { dismissed.add(offerD.id); offerD = null; }
      }
    }
    const map = { home: Home, jobs: Jobs, active: Active, chat: Chat, done: Done, earnings: Earnings, payouts: Payouts, history: History, profile: Profile, notifications: Notifications, verification: Verification, support: Support };
    const C = map[U.rider.screen] || Home;
    return html`<${C} />${offerD ? html`<${Offer} d=${offerD} r=${r} />` : null}`;
  };
})();
