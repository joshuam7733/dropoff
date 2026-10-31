/* Drop Off — vendor app. Every screen reads the signed-in business's data from the store; every action calls the backend. */
(function () {
  const D = window.DO, html = D.html, S = D.store, F = D.fmt, U = D.ui;
  const { Icon, VIcon, Chip, Progress, Btn, MapView, Timeline, PhotoView, PhotoCapture, Avatar, Empty, SigView } = D;
  const act = S.act;
  const V = () => S.vendor(S.me().vendorId);
  const go = (s, p) => D.nav('vendor', s, p);
  const dev = 'vendor';
  const mine = () => S.state.deliveries.filter((d) => d.vendorId === V().id);
  const trackingLink = (d) => { const base = S.state.settings.tracking_base_url || 'https://dropoff.app/t/'; return d.token ? base + d.token : null; };

  const Tabs = ({ cur }) => {
    const unread = S.state.notifications.filter((n) => n.aud === 'vendor' && !n.read).length;
    const t = (id, label, icon) => html`<button aria-current=${cur === id ? 'page' : null} onClick=${() => D.home(dev, id)}><${Icon} n=${icon} s="24" fill=${cur === id ? '#E4EFEA' : 'none'} />${label}</button>`;
    return html`<nav class="tabbar" aria-label="Vendor navigation">${t('home', 'Home', 'home')}${t('history', 'Deliveries', 'box')}
      <button onClick=${() => startNew()} aria-label="New delivery"><span class="newbtn"><${Icon} n="plus" s="22" w="2.6" /></span>New</button>
      ${t('wallet', 'Wallet', 'wallet')}<button aria-current=${cur === 'account' ? 'page' : null} onClick=${() => D.home(dev, 'account')}><${Icon} n="user" s="24" />Account${unread ? html`<span class="badge">${unread}</span>` : null}</button></nav>`;
  };

  function newDraft(extra) {
    const v = V();
    const loc = (v.locations.find((l) => l.default) || v.locations[0] || {}).placeId || null;
    const method = v.methods.some((m) => m.id === v.defaultMethod) ? v.defaultMethod : 'wallet';
    return Object.assign({ step: 'route', pickup: loc, dropoff: null, q: '', rName: '', rPhone: '', notes: '', type: null, desc: '', size: null, weight: '', value: '', fragile: false, upright: false, photo: null, urgency: 'standard', cls: null, method, errors: {} }, extra || {});
  }
  function startNew(extra) { U.vendor.draft = newDraft(extra); go('new'); }
  D.vendorStartNew = startNew;

  const VerifyBanner = ({ v }) => {
    if (v.verified) return null;
    const msg = { pending: 'Upload your business documents to unlock credit and invoicing.', submitted: 'Documents submitted. Ops will review them shortly.',
      under_review: 'Ops is reviewing your documents.', rejected: 'Verification was not approved. See why and resubmit.', suspended: 'This business account is suspended.' }[v.verification];
    return html`<button class=${'banner ' + (['rejected', 'suspended'].includes(v.verification) ? 'bad' : 'mari')} style="border:0;text-align:left;cursor:pointer" onClick=${() => go('verification')}><${Icon} n="clock" s="18" /><span><b>${D.VERIFY[v.verification].label}.</b> ${msg} You can book deliveries now.</span></button>`;
  };

  /* ---------------- home ---------------- */
  const DeliveryRow = ({ d }) => html`<button class="list-row" onClick=${() => go(D.ACTIVE.includes(d.status) ? 'track' : 'detail', { id: d.id })}>
    <span class="ibox"><${VIcon} c=${d.cls} s="22" /></span>
    <span class="grow"><span class="t1" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.pkg.desc} → ${d.recipient.name.split(' ')[0]}</span><span class="t2" style="display:block">${d.id} · ${F.dayTime(d.createdAt)} · ${F.ugx(d.price.total)}</span></span>
    <${Chip} status=${d.status} />
  </button>`;

  const Home = () => {
    const v = V();
    const active = mine().filter((d) => D.ACTIVE.includes(d.status));
    const unread = S.state.notifications.filter((n) => n.aud === 'vendor' && !n.read).length;
    const home = v.locations.find((l) => l.default) || v.locations[0];
    return html`<div class="app light"><div class="app-scroll with-tabs">
      <div class="hdr"><button class="iconbtn" style="background:var(--mari);border-radius:14px;font-family:var(--f-display);font-weight:800" onClick=${() => D.home(dev, 'account')} aria-label="Business profile">${v.initials}</button>
        <div style="flex:1;min-width:0"><div class="cap">Good day, ${(v.owner || '').split(' ')[0]}</div><div style="font-weight:700;font-size:16px">${v.name}</div></div>
        <button class="iconbtn" aria-label=${'Notifications, ' + unread + ' unread'} onClick=${() => go('notifications')}><${Icon} n="bell" s="22" />${unread ? html`<span class="dot"></span>` : null}</button></div>
      <${VerifyBanner} v=${v} />
      <div class="card ink" style="border-radius:26px;padding:20px 16px;display:flex;flex-direction:column;gap:14px">
        <h2 class="h-lg" style="font-size:27px">Send a package</h2>
        <button onClick=${() => startNew()} style="background:#fff;color:var(--ink);border:0;border-radius:18px;padding:4px 14px;text-align:left">
          <div style="display:flex;align-items:center;gap:12px;height:44px"><span style="width:10px;height:10px;border-radius:50%;background:var(--ink)"></span><span style="font-weight:600">${home && S.place(home.placeId) ? S.place(home.placeId).name : 'Add a pickup location'}</span></div>
          <div style="height:1px;background:var(--line);margin-left:22px"></div>
          <div style="display:flex;align-items:center;gap:12px;height:48px"><span style="width:10px;height:10px;border-radius:3px;background:var(--mari)"></span><span style="font-weight:700;font-size:16px;flex:1">Where's it going?</span><${Icon} n="search" s="20" /></div>
        </button>
      </div>
      <button class="card" style="display:flex;align-items:center;gap:12px;border:0;text-align:left" onClick=${() => D.home(dev, 'wallet')}>
        <span class="ibox pine"><${Icon} n="wallet" /></span><span style="flex:1"><span class="cap" style="display:block">Wallet balance${v.walletPending ? ' · ' + F.ugx(v.walletPending) + ' reserved' : ''}</span><b style="font-size:18px">${F.ugx(v.wallet)}</b></span><span class="btn sm ink" style="pointer-events:none">Top up</span>
      </button>
      <div class="card map-card"><div class="map-card-head"><div><b>Drivers near you</b><div class="cap">${(() => { const sup = D.supply(); const n = sup.reduce((s, c) => s + c.n, 0); return n ? n + ' free driver' + (n === 1 ? '' : 's') + ' online now · zoom to explore' : 'No free drivers online right now · pinch or scroll to explore'; })()}</div></div></div>
        <${MapView} supply=${D.supply()} places=${true} extraPts=${home && S.place(home.placeId) ? [S.place(home.placeId)] : []} height=${230} label="Map of pickup points and available drivers" /></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline"><h2 class="h-md">Active now · ${active.length}</h2><button class="linkbtn" onClick=${() => D.home(dev, 'history')}>All deliveries</button></div>
      ${active.length ? html`<div class="card pad0">${active.map((d) => html`<button class="list-row" onClick=${() => go('track', { id: d.id })} style="flex-direction:column;align-items:stretch;gap:8px;padding:12px 0">
          <span style="display:flex;align-items:center;gap:12px"><span class="ibox ink"><${VIcon} c=${d.cls} s="22" /></span><span class="grow"><span class="t1" style="display:block">${d.pkg.desc}</span><span class="t2" style="display:block">${d.id} → ${d.recipient.name} · ${d.dropoff.area}</span></span><${Chip} status=${d.status} /></span>
          <${Progress} status=${d.status} />
        </button>`)}</div>` : html`<div class="card"><${Empty} icon="box" title="No active deliveries" body="Book a rider in under a minute." action=${html`<button class="btn sm" onClick=${() => startNew()}>New delivery</button>`} /></div>`}
    </div><${Tabs} cur="home" /></div>`;
  };

  /* ---------------- create delivery wizard ---------------- */
  const STEPS = ['route', 'recipient', 'package', 'vehicle', 'review'];
  const STEP_FIELDS = { route: ['pickup', 'dropoff'], recipient: ['rName', 'rPhone'], package: ['type', 'desc', 'weight', 'size', 'value', 'photo'], vehicle: ['cls'], review: [] };
  const StepBar = ({ step }) => html`<div style="flex:1;display:flex;gap:5px">${STEPS.map((s, i) => html`<div style=${'flex:1;height:5px;border-radius:3px;background:' + (i <= STEPS.indexOf(step) ? 'var(--ink)' : 'var(--line)')}></div>`)}</div>`;
  const Err = ({ e }) => (e ? html`<div class="ferr">${e}</div>` : null);

  function next(dr) {
    const errs = S.validateDraft(dr, dr.step);
    const own = {};
    STEPS.slice(0, STEPS.indexOf(dr.step) + 1).forEach((s) => STEP_FIELDS[s].forEach((f) => { if (errs[f]) own[f] = errs[f]; }));
    dr.errors = own;
    if (Object.keys(own).length) { D.rerender(); return; }
    if (dr.step === 'package' && (!dr.cls || !S.eligibleClasses({ size: dr.size, weight: +dr.weight }).includes(dr.cls))) dr.cls = S.recommend({ size: dr.size, weight: +dr.weight });
    dr.step = STEPS[STEPS.indexOf(dr.step) + 1];
    D.rerender();
    const sc = document.querySelector('[data-dev="vendor"] .app-scroll'); if (sc) sc.scrollTop = 0;
  }
  const setD = (dr, k) => (e) => { dr[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; delete dr.errors[k]; D.rerender(); };

  const Wizard = () => {
    const v = V();
    const dr = U.vendor.draft || (U.vendor.draft = newDraft());
    const back = () => { if (dr.step === 'route') D.back(dev); else { dr.step = STEPS[STEPS.indexOf(dr.step) - 1]; D.rerender(); } };
    const titles = { route: "Where's it going?", recipient: "Who's receiving it?", package: 'What are you sending?', vehicle: 'Choose a vehicle', review: 'Review delivery' };
    let body = null, cta = null;
    if (dr.step === 'route') {
      const q = (dr.q || '').toLowerCase();
      const opts = D.PLACES.filter((p) => !v.locations.some((l) => l.placeId === p.id) && (!q || (p.name + ' ' + p.area).toLowerCase().includes(q)));
      body = html`
        <div class="field"><label for="w-pick">Pickup</label><select id="w-pick" class="input" value=${dr.pickup || ''} onChange=${setD(dr, 'pickup')}>${v.locations.map((l) => html`<option value=${l.placeId}>${(S.place(l.placeId) || {}).name || l.label}</option>`)}</select><${Err} e=${dr.errors.pickup} /></div>
        <div class="field"><label for="w-q">Drop-off</label><input id="w-q" class=${'input' + (dr.errors.dropoff ? ' err' : '')} placeholder="Search a place or area" value=${dr.q} onInput=${(e) => { dr.q = e.target.value; D.rerender(); }} /><${Err} e=${dr.errors.dropoff} /></div>
        <div class="card pad0" role="listbox" aria-label="Drop-off places">${opts.slice(0, 9).map((p) => { const z = S.zone(p.zone); const sel = dr.dropoff === p.id; return html`<button class="list-row" role="option" aria-selected=${sel} onClick=${() => { dr.dropoff = p.id; dr.q = p.name; delete dr.errors.dropoff; D.rerender(); }} style=${sel ? 'background:var(--pine-soft);margin:0 -16px;padding:8px 16px;width:calc(100% + 32px)' : ''}>
          <span class="ibox" style=${sel ? 'background:var(--mari)' : ''}><${Icon} n="pin" s="18" /></span><span class="grow"><span class="t1" style="display:block">${p.name}</span><span class="t2" style="display:block">${p.area}${z.enabled ? '' : ' · outside service area'}</span></span><span class="cap">${dr.pickup ? S.kmBetween(S.place(dr.pickup), p) + ' km' : ''}</span></button>`; })}
          ${!opts.length ? html`<div class="empty">No places match “${dr.q}”. Try an area name such as Ntinda or Bugolobi.</div>` : null}</div>`;
      cta = html`<${Btn} onClick=${() => next(dr)}>Confirm drop-off<//>`;
    } else if (dr.step === 'recipient') {
      const saved = savedRecipients(v).slice(0, 4);
      body = html`
        ${saved.length ? html`<div class="pills scroll">${saved.map((r) => html`<button class="pill" aria-pressed=${dr.rPhone && S.normPhone(dr.rPhone) === r.phone ? 'true' : 'false'} onClick=${() => { dr.rName = r.name; dr.rPhone = r.phone.replace('+256 ', '0'); dr.notes = dr.notes || r.notes || ''; dr.errors = {}; D.rerender(); }}>${r.name}</button>`)}</div>` : null}
        <div class="field"><label for="w-rn">Full name</label><input id="w-rn" class=${'input' + (dr.errors.rName ? ' err' : '')} autocomplete="off" value=${dr.rName} onInput=${setD(dr, 'rName')} /><${Err} e=${dr.errors.rName} /></div>
        <div class="field"><label for="w-rp">Phone number</label><input id="w-rp" class=${'input' + (dr.errors.rPhone ? ' err' : '')} inputmode="tel" placeholder="07XX XXX XXX" value=${dr.rPhone} onInput=${setD(dr, 'rPhone')} />${dr.errors.rPhone ? html`<${Err} e=${dr.errors.rPhone} />` : html`<div class="hint">They get an SMS with a tracking link and a delivery PIN.</div>`}</div>
        <div class="field"><label for="w-notes">Directions for the driver</label><textarea id="w-notes" class="input" rows="2" placeholder="Gate, floor, landmark" value=${dr.notes} onInput=${setD(dr, 'notes')}></textarea></div>`;
      cta = html`<${Btn} onClick=${() => next(dr)}>Continue to package<//>`;
    } else if (dr.step === 'package') {
      const rec = dr.size && +dr.weight > 0 ? S.recommend({ size: dr.size, weight: +dr.weight }) : null;
      const onPhoto = async (p) => {
        dr.photoUploading = true; dr.photo = { src: p.src, ts: p.ts }; D.rerender();
        try { dr.photo = await act.uploadPackagePhoto(v.id, p); } catch (e) { dr.photo = null; D.toast(dev, e.message, 'err'); }
        dr.photoUploading = false; delete dr.errors.photo; D.rerender();
      };
      body = html`
        <div class="field"><span class="lbl">Type</span><div class="pills">${D.TYPES.map((t) => html`<button class="pill" aria-pressed=${dr.type === t.id ? 'true' : 'false'} onClick=${() => { dr.type = t.id; if (!dr.sizeTouched) dr.size = t.size; delete dr.errors.type; D.rerender(); }}>${t.label}</button>`)}</div><${Err} e=${dr.errors.type} /></div>
        <div class="field"><label for="w-desc">Description</label><textarea id="w-desc" class=${'input' + (dr.errors.desc ? ' err' : '')} rows="2" placeholder="e.g. 3-tier wedding cake, boxed per tier" value=${dr.desc} onInput=${setD(dr, 'desc')}></textarea><${Err} e=${dr.errors.desc} /></div>
        <div class="field"><span class="lbl">Size</span>${D.SIZES.map((s) => { const sel = dr.size === s.id; return html`<button onClick=${() => { dr.size = s.id; dr.sizeTouched = true; delete dr.errors.size; delete dr.errors.weight; D.rerender(); }} style=${'display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:16px;text-align:left;background:' + (sel ? 'var(--pine-soft)' : '#fff') + ';border:' + (sel ? '2px solid var(--ink)' : '1px solid var(--line)')} aria-pressed=${sel ? 'true' : 'false'}>
          <span style=${'width:20px;height:20px;border-radius:50%;box-sizing:border-box;flex-shrink:0;border:' + (sel ? '7px solid var(--ink);background:#fff' : '2px solid #8C9792')}></span><span style="flex:1"><b style="display:block">${s.label}</b><span class="cap">${s.hint}</span></span><span class="cap" style="font-weight:700">${S.cls(s.best).label}</span></button>`; })}<${Err} e=${dr.errors.size} /></div>
        <div class="row2"><div class="field"><label for="w-kg">Weight (kg)</label><input id="w-kg" class=${'input' + (dr.errors.weight ? ' err' : '')} inputmode="decimal" value=${dr.weight} onInput=${setD(dr, 'weight')} /></div><div class="field"><label for="w-val">Value (UGX)</label><input id="w-val" class=${'input' + (dr.errors.value ? ' err' : '')} inputmode="numeric" value=${dr.value} onInput=${setD(dr, 'value')} /></div></div>
        <${Err} e=${dr.errors.weight || dr.errors.value} />
        <div class="field"><span class="lbl">Handling</span><div class="pills"><button class="pill" aria-pressed=${dr.fragile ? 'true' : 'false'} onClick=${() => { dr.fragile = !dr.fragile; D.rerender(); }}><${Icon} n="glass" s="15" />Fragile</button><button class="pill" aria-pressed=${dr.upright ? 'true' : 'false'} onClick=${() => { dr.upright = !dr.upright; D.rerender(); }}><${Icon} n="upright" s="15" />Keep upright</button></div></div>
        <div class="field"><span class="lbl">Urgency</span><div class="row2"><button class="pill" style="justify-content:center;height:44px" aria-pressed=${dr.urgency === 'standard' ? 'true' : 'false'} onClick=${() => { dr.urgency = 'standard'; D.rerender(); }}>Standard</button><button class="pill" style="justify-content:center;height:44px" aria-pressed=${dr.urgency === 'express' ? 'true' : 'false'} onClick=${() => { dr.urgency = 'express'; D.rerender(); }}><${Icon} n="bolt" s="15" />Express</button></div></div>
        <div class="field"><span class="lbl">Package photo <span class="cap">(optional · shown to the driver)</span></span><${PhotoCapture} id="w-photo" photo=${dr.photo} busy=${dr.photoUploading} label="Package photo" onPhoto=${onPhoto} /><${Err} e=${dr.errors.photo} /></div>
        ${rec ? html`<div class="banner mari pop" key=${rec}><${Icon} n="bolt" s="18" /><span><b>Recommended: ${S.cls(rec).label}</b><br />${rec === 'boda' ? 'Fastest and cheapest for small items.' : 'Boda riders won’t be offered this job.'}</span></div>` : dr.size && +dr.weight > 0 ? html`<div class="banner bad"><${Icon} n="alert" s="18" /><span>No vehicle can carry this combination. Check the size and weight.</span></div>` : null}`;
      cta = html`<${Btn} disabled=${dr.photoUploading} onClick=${() => next(dr)}>See vehicles & price<//>`;
    } else if (dr.step === 'vehicle') {
      const pkg = { size: dr.size, weight: +dr.weight };
      const el = S.eligibleClasses(pkg);
      const rec = S.recommend(pkg);
      const pick = S.place(dr.pickup), drop = S.place(dr.dropoff);
      const sizeEl = S.sizeOf(dr.size).eligible;
      body = html`<div class="cap">${S.sizeOf(dr.size).label} · ${dr.weight} kg${dr.fragile ? ' · fragile' : ''} · ${S.kmBetween(pick, drop)} km</div>
        ${D.CLASS_ORDER.map((c) => {
          const C = S.cls(c);
          const ok = el.includes(c);
          const why = !C.enabled ? 'Not available · switched off by ops' : !sizeEl.includes(c) ? "Can't take a " + S.sizeOf(dr.size).label.toLowerCase() + ' package' : 'Max ' + F.num(C.maxKg) + ' kg';
          const q = ok ? S.quote({ pickup: pick, dropoff: drop, cls: c, fragile: dr.fragile, express: dr.urgency === 'express' }) : null;
          const sel = dr.cls === c;
          return html`<button disabled=${!ok} onClick=${() => { dr.cls = c; delete dr.errors.cls; D.rerender(); }} aria-pressed=${sel ? 'true' : 'false'} style=${'display:flex;align-items:center;gap:12px;padding:10px 13px;border-radius:16px;text-align:left;background:' + (!ok ? 'var(--mist)' : sel ? 'var(--pine-soft)' : '#fff') + ';border:' + (sel ? '2px solid var(--ink)' : '1px solid ' + (ok ? 'var(--line)' : 'transparent')) + ';opacity:' + (ok ? 1 : 0.75)}>
            <span class=${'ibox ' + (sel ? 'ink' : '')}><${VIcon} c=${c} s="26" /></span>
            <span style="flex:1;min-width:0"><span style="display:flex;gap:6px;align-items:center;font-weight:700;font-size:15px">${C.label}${c === rec ? html`<span class="chip solid" style="height:20px;font-size:11px">Best fit</span>` : null}</span><span class="cap">${ok ? 'Up to ' + F.num(C.maxKg) + ' kg · about ' + Math.round(S.minsFor(S.geo.pathLen(S.geo.route(pick, drop)), c)) + ' min drive' : why}</span></span>
            ${ok ? html`<b class="tnum">${F.ugx(q.total)}</b>` : html`<${Icon} n="lock" s="18" c="#5F6C67" />`}
          </button>`;
        })}<${Err} e=${dr.errors.cls} />
        <div class="cap" style="display:flex;gap:6px;align-items:center;justify-content:center"><${Icon} n="shield" s="15" c="#17804F" />Fixed price before you book</div>`;
      const q = dr.cls && el.includes(dr.cls) ? S.quote({ pickup: pick, dropoff: drop, cls: dr.cls, fragile: dr.fragile, express: dr.urgency === 'express' }) : null;
      cta = html`<${Btn} disabled=${!q} onClick=${() => next(dr)}>${q ? 'Continue with ' + S.cls(dr.cls).label + ' · ' + F.ugx(q.total) : 'Choose a vehicle'}<//>`;
    } else {
      const pick = S.place(dr.pickup), drop = S.place(dr.dropoff);
      const q = S.quote({ pickup: pick, dropoff: drop, cls: dr.cls, fragile: dr.fragile, express: dr.urgency === 'express' });
      const sig = +dr.value >= 300000 || dr.type === 'documents';
      const remaining = v.credit.limit - v.credit.used - v.credit.pending;
      const me = S.me();
      const ext = ['momo', 'airtel', 'card'].includes(dr.method);
      if (dr.payerPhone == null) dr.payerPhone = me.phone ? me.phone.replace('+256 ', '0').replace(/ /g, '') : '';
      const methodNote = (m) => m.id === 'wallet' ? F.ugx(v.wallet) + ' available' : m.id === 'credit' ? F.ugx(remaining) + ' credit left'
        : m.id === 'card' ? 'Pay on the secure card page' : 'Approve the prompt on your phone';
      const netWrong = ['momo', 'airtel'].includes(dr.method) && S.validPhone(dr.payerPhone) && D.payments.network(dr.payerPhone) !== dr.method;
      body = html`
        <div class="card" style="display:flex;gap:12px"><div style="display:flex;flex-direction:column;align-items:center;padding-top:5px"><span style="width:10px;height:10px;border-radius:50%;background:var(--ink)"></span><span style="width:2px;flex:1;background:var(--line);margin:4px 0"></span><span style="width:10px;height:10px;border-radius:3px;background:var(--mari)"></span></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:12px"><div><b>${pick.name}</b><div class="cap">Pickup · driver gets your pickup PIN</div></div><div><b>${drop.name}</b><div class="cap">${dr.rName} · ${S.normPhone(dr.rPhone)}</div></div></div>
          <button class="linkbtn" style="align-self:flex-start" onClick=${() => { dr.step = 'route'; D.rerender(); }}>Edit</button></div>
        <div class="card pad0">
          <button class="list-row" onClick=${() => { dr.step = 'package'; D.rerender(); }}><${Icon} n="box" /><span class="grow"><span class="t1" style="display:block">${dr.desc}</span><span class="t2">${S.sizeOf(dr.size).label} · ${dr.weight} kg${dr.fragile ? ' · fragile' : ''}${dr.upright ? ' · upright' : ''}${dr.photo ? ' · 1 photo' : ''}</span></span><${Icon} n="chevR" s="18" c="#5F6C67" /></button>
          <button class="list-row" onClick=${() => { dr.step = 'vehicle'; D.rerender(); }}><${VIcon} c=${dr.cls} s="20" /><span class="grow"><span class="t1" style="display:block">${S.cls(dr.cls).label}${dr.urgency === 'express' ? ' · Express' : ''}</span><span class="t2">${dr.cls === S.recommend({ size: dr.size, weight: +dr.weight }) ? 'Best fit for this package' : 'Your choice'}</span></span><${Icon} n="chevR" s="18" c="#5F6C67" /></button>
          <div class="list-row"><${Icon} n="shield" /><span class="grow"><span class="t1" style="display:block">Proof: PIN + photo${sig ? ' + signature' : ''}</span><span class="t2">${sig ? 'Signature required for value ≥ UGX 300,000 or documents' : 'GPS and time recorded at handover'}</span></span></div>
        </div>
        <div class="card" style="display:flex;flex-direction:column;gap:8px">${q.lines.map((l) => html`<div style="display:flex;justify-content:space-between;color:var(--ink2)"><span>${l.label}</span><span class="tnum">${F.ugx(l.amount)}</span></div>`)}
          <div style="height:1px;background:var(--line)"></div><div style="display:flex;justify-content:space-between;align-items:baseline"><b>Total</b><b style="font-size:20px" class="tnum">${F.ugx(q.total)}</b></div></div>
        <div class="field"><span class="lbl">Pay with</span><div class="card pad0" role="radiogroup" aria-label="Payment method">${v.methods.map((m) => { const sel = dr.method === m.id; return html`<button class="list-row" role="radio" aria-checked=${sel} onClick=${() => { dr.method = m.id; D.rerender(); }}>
          <span class="ibox" style=${m.id === 'wallet' ? 'background:var(--ink);color:var(--mari)' : ''}><${Icon} n=${m.id === 'wallet' ? 'wallet' : m.id === 'card' ? 'card' : m.id === 'credit' ? 'receipt' : 'phone'} s="18" /></span>
          <span class="grow"><span class="t1" style="display:block">${m.label}</span><span class="t2">${methodNote(m)}</span></span>
          <span style=${'width:22px;height:22px;border-radius:50%;box-sizing:border-box;border:' + (sel ? '7px solid var(--ink)' : '2px solid #8C9792')}></span></button>`; })}</div>
          ${['momo', 'airtel'].includes(dr.method) ? html`<div class="field" style="margin-top:10px"><label for="w-payer">${D.payments.methodLabel(dr.method)} number to charge</label>
            <input id="w-payer" class=${'input' + (netWrong ? ' err' : '')} inputmode="tel" autocomplete="tel" value=${dr.payerPhone} onInput=${(e) => { dr.payerPhone = e.target.value; D.rerender(); }} />
            ${netWrong ? html`<div class="ferr">That looks like ${D.payments.network(dr.payerPhone) === 'momo' ? 'an MTN' : 'an Airtel'} number. Choose ${D.payments.network(dr.payerPhone) === 'momo' ? 'MTN Mobile Money' : 'Airtel Money'} or another number.</div>` : null}</div>` : null}
          <div class="hint">${ext ? 'Drivers see the job only after the payment is confirmed by ' + D.payments.methodLabel(dr.method) + '. ' + (D.payments.sandbox({ provider: (S.state.settings.payment_provider || 'sandbox') }) ? D.payments.label + '.' : '') : dr.method === 'wallet' ? 'The amount is reserved now and charged when the delivery is completed.' : 'Billed on your monthly invoice when the delivery is completed.'}</div>
          ${ext && !me.phoneVerified ? html`<div style="margin-top:10px"><${D.PhoneVerify} dev=${dev} title="Verify your phone to pay by mobile money or card" /></div>` : null}</div>`;
      const confirm = async () => {
        const out = await D.run('v-confirm', () => act.confirmDelivery(v.id, dr), { dev });
        if (out && out.delivery && out.delivery.id) { U.vendor.draft = null; U.vendor.stack = []; U.vendor.screen = 'home'; go('track', { id: out.delivery.id }); }
        else D.rerender();
      };
      cta = html`<${Btn} busy=${D.busy('v-confirm')} disabled=${netWrong || (ext && !me.phoneVerified)} label=${ext ? 'Sending payment request…' : 'Confirming…'} onClick=${confirm}>${ext ? 'Pay ' + F.ugx(q.total) + ' & request driver' : 'Request driver · ' + F.ugx(q.total)}<//>`;
    }
    return html`<div class="app light" style="background:${dr.step === 'review' ? 'var(--mist)' : '#fff'}"><div class="app-scroll">
      <div class="hdr"><button class="iconbtn mist" aria-label="Back" onClick=${back}><${Icon} n="chevL" s="22" /></button><${StepBar} step=${dr.step} /><span class="cap">${STEPS.indexOf(dr.step) + 1} of 5</span></div>
      <h1 class="h-xl" style="font-size:27px">${titles[dr.step]}</h1>
      ${body}
    </div><div class="app-bottom raised">${cta}</div>
    </div>`;
  };

  function savedRecipients() {
    const seen = new Map();
    mine().forEach((d) => { if (d.recipient.hidden) return; if (!seen.has(d.recipient.phone)) seen.set(d.recipient.phone, { name: d.recipient.name, phone: d.recipient.phone, placeId: d.dropoff.placeId, area: d.dropoff.area, count: 0, notes: d.recipient.notes }); seen.get(d.recipient.phone).count++; });
    return [...seen.values()];
  }

  /* ---------------- tracking (status-driven) ---------------- */
  const DriverCard = ({ d }) => {
    const r = S.rider(d.riderId);
    if (!r) return null;
    return html`<div style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:18px;background:var(--mist)">
      <div style="position:relative"><${Avatar} name=${r.name} s="46" /><span style="position:absolute;right:-4px;bottom:-3px;background:var(--ink);color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:999px;border:2px solid #fff">${r.rating.toFixed(1)}</span></div>
      <div style="flex:1;min-width:0"><b>${r.name}</b><div class="cap">${r.color} ${r.make} · ${F.num(r.trips)} deliveries</div></div>
      <span class="mono" style="font-size:12px;padding:5px 7px;border:2px solid var(--ink);border-radius:8px;background:#fff">${r.plate}</span>
    </div>
    <div class="cap" style="display:flex;gap:6px;align-items:center"><${Icon} n="pin" s="14" />${r.loc ? 'Live GPS · updated ' + F.ago(r.loc.updatedAt) : 'Live location not shared yet · times are estimates'}</div>
    <div class="row2"><${Btn} kind="white md" busy=${D.busy('v-call')} label="Logging…" onClick=${() => D.run('v-call', () => act.call(d.id, 'vendor', 'rider'), { dev, ok: 'Call request logged. Masked calling is not connected yet.' })}><${Icon} n="phone" s="18" />Call<//><${Btn} kind="white md" onClick=${() => go('detail', { id: d.id })}><${Icon} n="receipt" s="18" />Details<//></div>`;
  };

  const share = (d) => {
    const t = trackingLink(d);
    if (!t) return;
    try { navigator.clipboard.writeText(t).then(() => D.toast(dev, 'Tracking link copied: ' + t), () => D.toast(dev, 'Tracking link: ' + t)); } catch (e) { D.toast(dev, 'Tracking link: ' + t); }
  };

  const Track = () => {
    const d = S.delivery(U.vendor.params.id);
    if (!d) return html`<div class="app light"><div class="app-scroll"><${D.Back} dev=${dev} /><${Empty} title="Delivery not found" body="It may belong to another business account." /></div></div>`;
    const r = d.riderId && S.rider(d.riderId);
    const rn = r ? F.first(r.name) : '';
    const st = d.status;
    const mapH = ['delivered', 'disputed', 'cancelled', 'failed'].includes(st) ? 250 : st === 'searching' ? 380 : 360;
    let sheet;
    if (st === 'draft') {
      sheet = html`<div style="display:flex;gap:8px;align-items:center"><${Chip} status="draft" /><span class="mono cap">${d.id}</span></div>
        <h2 class="h-lg">Confirm the payment to book</h2><div class="sub">Drivers see this delivery as soon as ${D.payments.methodLabel(d.payment.method)} confirms ${F.ugx(d.price.total)}.</div>
        <${D.PaymentStatus} id=${d.payment.id} onRetry=${() => D.run('v-pay-retry', () => act.initiatePayment(d.payment.id), { dev })} />
        <button class="linkbtn" style="color:var(--ink2)" onClick=${() => D.run('v-cancel', () => act.vendorCancel(d.id, 'Cancelled before payment'), { dev, ok: 'Booking cancelled · nothing was sent to drivers' })}>Cancel this booking</button>`;
    } else if (st === 'searching' || st === 'pending') {
      const canWiden = !d.widened && S.eligibleClasses(d.pkg).some((c) => D.CLASS_ORDER.indexOf(c) > D.CLASS_ORDER.indexOf(d.cls));
      const n = d.eligibleOnline || 0;
      sheet = html`<div style="display:flex;gap:8px;align-items:center"><${Chip} status="searching" /><span class="mono cap">${d.id}</span></div>
        <h2 class="h-lg">${!n ? 'No ' + S.cls(d.cls).label.toLowerCase() + ' drivers free yet' : 'Matching you with a ' + S.cls(d.cls).label.toLowerCase() + ' driver'}</h2>
        ${!n ? html`<div class="banner bad"><${Icon} n="alert" s="18" /><span>No eligible driver is online and free right now. The request stays open and ops has been alerted. Your payment is only reserved.</span></div>`
        : html`<div class="banner info"><${Icon} n="send" s="18" /><span>Your request is in front of <b>${n} eligible driver${n === 1 ? '' : 's'}</b>. The first to accept gets the job.</span></div><div style="height:6px;border-radius:3px;background:var(--info-soft);overflow:hidden"><div style="height:6px;width:40%;border-radius:3px;background:var(--info);animation:slide 1.4s ease-in-out infinite alternate"></div></div><style>@keyframes slide{from{transform:translateX(-30%)}to{transform:translateX(180%)}}</style>`}
        <div class="pills"><span class="chip grey">${d.widened ? S.cls(d.cls).label + ' or larger' : S.cls(d.cls).label + ' only'}</span>${d.pkg.fragile ? html`<span class="chip grey">Fragile</span>` : null}<span class="chip grey">Waiting ${F.mins((Date.now() - d.createdAt) / 60000)}</span></div>
        <div class="row2">${canWiden ? html`<${Btn} kind="ink md" busy=${D.busy('v-widen')} onClick=${() => D.run('v-widen', () => act.widen(d.id), { dev, ok: 'Larger vehicles can now take this job at the same price' })}>Allow larger<//>` : html`<${Btn} kind="white md" onClick=${() => D.toast(dev, "We'll notify you as soon as a driver accepts.")}>Keep waiting<//>`}<${Btn} kind="ghost md" busy=${D.busy('v-cancel')} label="Cancelling…" onClick=${() => D.run('v-cancel', () => act.vendorCancel(d.id, 'Cancelled while searching'), { dev, ok: 'Cancelled · reserved amount released' })}>Cancel · refund<//></div>`;
    } else if (['assigned', 'en_route_pickup', 'at_pickup'].includes(st)) {
      const title = st === 'assigned' ? rn + ' accepted your delivery' : st === 'en_route_pickup' ? rn + ' is heading to you' : rn + ' has arrived for pickup';
      const sub = st === 'en_route_pickup' ? (d.leg ? 'About ' + F.mins(S.minsFor(d.leg.len, d.cls)) + ' away · ' + F.km(d.leg.len) + ' · live GPS' : 'On the way to ' + d.pickup.area) : st === 'assigned' ? 'Starting the trip to ' + d.pickup.name : 'Give the package and the PIN below to ' + rn;
      sheet = html`<div><h2 class="h-lg">${title}</h2><div class="sub">${sub}</div></div><${Progress} status=${st} />
        <div class=${'banner ' + (st === 'at_pickup' ? 'mari pop' : 'mari')} style="align-items:center"><div style="flex:1"><b>Pickup PIN</b><div class="cap">Share it only once the package is in ${rn}'s hands</div></div><span class="mono" style="font-size:28px;letter-spacing:0.12em">${d.pickupPin || '••••'}</span></div>
        <${DriverCard} d=${d} />
        <button class="linkbtn" style="color:var(--ink2)" onClick=${() => D.run('v-cancel', () => act.vendorCancel(d.id), { dev, ok: 'Cancelled before pickup · reserved amount released' })}>Cancel delivery (free until pickup)</button>`;
    } else if (['picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation'].includes(st)) {
      const mins = S.legEtaMin(d);
      const title = st === 'arrived' ? rn + ' is at the drop-off' : st === 'awaiting_confirmation' ? 'Handing over to ' + d.recipient.name.split(' ')[0] : st === 'picked_up' ? 'Picked up · leaving ' + d.pickup.area : F.mins(mins) + ' to ' + d.recipient.name.split(' ')[0];
      sheet = html`<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div><h2 class="h-lg">${title}</h2><div class="sub">${st === 'awaiting_confirmation' ? 'Waiting for the recipient PIN' : st === 'arrived' ? 'Waiting for ' + d.recipient.name.split(' ')[0] : (S.etaLive(d) ? 'Arrives around ' : 'Estimated arrival around ') + F.time(Date.now() + S.etaMs(d))}${d.late ? ' · running late' : ''}</div></div><${Chip} status=${st} /></div>
        <${Progress} status=${st} />
        <div style="display:flex;flex-direction:column;gap:8px">${d.events.slice(-3).reverse().map((e) => html`<div style="display:flex;gap:10px;font-size:13.5px;align-items:center"><span style="width:22px;height:22px;border-radius:50%;background:var(--ok-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0"><${Icon} n="check" s="12" c="#17804F" w="3" /></span><span style="flex:1">${e.label}</span><span class="cap">${F.time(e.ts)}</span></div>`)}</div>
        <${DriverCard} d=${d} />
        <${Btn} kind="ink md" onClick=${() => share(d)}><${Icon} n="share" s="18" />Share tracking link<//>
        ${D.api.local && trackingLink(d) ? html`<${Btn} kind="white md" onClick=${() => { location.href = trackingLink(d); }}><${Icon} n="user" s="18" />See it as the recipient<//>` : null}`;
    } else if (st === 'delivered' || st === 'disputed') {
      const p = d.proof.drop;
      sheet = html`<div style="display:flex;align-items:center;gap:12px" class="pop"><span style="width:52px;height:52px;border-radius:50%;background:var(--mari);display:flex;align-items:center;justify-content:center"><${Icon} n="check" s="28" w="2.8" /></span><div><h2 class="h-lg">${st === 'disputed' ? 'Delivered · under dispute' : 'Delivered'}</h2><div class="sub">To ${p.receiverName || d.recipient.name} at ${F.time(p.ts || d.statusAt)}</div></div></div>
        <div class="card pad0" style="background:var(--mist)"><div class="kv"><span>PIN</span><span>✓ confirmed by the ${p.pinBy || 'recipient'}</span></div><div class="kv"><span>GPS</span><span>${p.distM != null ? p.distM + ' m from the drop-off' : 'No GPS fix at handover'}</span></div><div class="kv"><span>Signature</span><span><${SigView} value=${p.signature} required=${d.sigRequired} /></span></div></div>
        <div class="row2"><${Btn} kind="ink md" onClick=${() => go('detail', { id: d.id })}>Proof & timeline<//><${Btn} kind="md" onClick=${() => go('receipt', { id: d.id })}>Receipt<//></div>`;
    } else if (st === 'failed') {
      sheet = html`<div class="banner bad"><${Icon} n="alert" s="18" /><span><b>Delivery failed.</b> ${d.failReason}. The refund for the failed attempt is in your ${d.payment.method === 'credit' ? 'credit account' : 'wallet'}.</span></div>
        ${d.resolution ? html`<div class="banner info">${d.resolution === 'returned' ? 'Package returning to ' + d.pickup.name + '.' : 'Resolved.'}</div>` : html`<div class="row2"><${Btn} kind="ink md" busy=${D.busy('v-re')} onClick=${() => D.run('v-re', () => act.reattempt(d.id), { dev, ok: 'Driver is trying again' })}>Try again<//><${Btn} kind="white md" busy=${D.busy('v-ret')} onClick=${() => D.run('v-ret', () => act.returnToVendor(d.id), { dev, ok: 'Return arranged' })}>Return to me<//></div>`}
        <${Btn} kind="ghost md" onClick=${() => go('detail', { id: d.id })}>Details & timeline<//>`;
    } else {
      sheet = html`<div class="banner info"><${Icon} n="x" s="18" /><span>${d.cancelReason || 'Cancelled'}${['refunded', 'partially_refunded'].includes(d.payment.status) ? ' · ' + F.ugx(d.payment.refunded) + ' refunded' : ''}</span></div><${Btn} kind="ink md" onClick=${() => startNew({ ...draftFrom(d), step: 'review' })}>Book again<//>`;
    }
    return html`<div class="app light" style="background:#E9EDE8">
      <div style="position:relative"><${MapView} d=${d} height=${mapH} label=${'Live map for ' + d.id} />
        <div style="position:absolute;top:46px;left:16px;right:16px;display:flex;justify-content:space-between;align-items:center"><button class="iconbtn" aria-label="Back" style="box-shadow:0 4px 14px rgba(13,43,35,.15)" onClick=${() => D.back(dev)}><${Icon} n="chevL" s="22" /></button><span class="map-tag" style="position:static"><span style=${'width:7px;height:7px;border-radius:50%;background:' + (D.api.realtime === 'live' ? '#3DD68C' : '#FFB71B')}></span>${d.id} · ${D.api.realtime === 'live' ? 'live' : 'updating'}</span></div></div>
      <div class="sheet" style="flex:1;overflow-y:auto;margin-top:-26px;position:relative"><div class="grabber"></div>${sheet}</div>
    </div>`;
  };

  function draftFrom(d) {
    return { pickup: d.pickup.placeId || ((V().locations[0] || {}).placeId), dropoff: d.dropoff.placeId, q: d.dropoff.name, rName: d.recipient.name, rPhone: d.recipient.phone.replace('+256 ', '0'), notes: d.recipient.notes, type: d.pkg.type, desc: d.pkg.desc, size: d.pkg.size, sizeTouched: true, weight: String(d.pkg.weight), value: d.pkg.value ? String(d.pkg.value) : '', fragile: d.pkg.fragile, upright: d.pkg.upright, urgency: d.urgency, cls: d.cls };
  }

  /* ---------------- detail, receipt, history ---------------- */
  const Detail = () => {
    const d = S.delivery(U.vendor.params.id);
    if (!d) return html`<div class="app light"><div class="app-scroll"><${D.Back} dev=${dev} /><${Empty} title="Delivery not found" body="" /></div></div>`;
    const r = d.riderId && S.rider(d.riderId);
    const pp = d.proof.pickup, dp = d.proof.drop;
    const t = U.tmpOf.vendor;
    const openTicket = S.state.tickets.find((x) => x.did === d.id && !['resolved', 'closed'].includes(x.status));
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} /><div style="flex:1"><div class="mono" style="font-size:15px">${d.id}</div><div class="cap">Booked ${F.dayTime(d.createdAt)}</div></div><${Chip} status=${d.status} /></div>
      ${D.ACTIVE.includes(d.status) ? html`<${Btn} kind="ink md" onClick=${() => go('track', { id: d.id })}><${Icon} n="pin" s="18" />Open live tracking<//>` : null}
      ${openTicket ? html`<div class="banner mari"><${Icon} n="help" s="18" /><span>Support case ${openTicket.id} · ${D.TICKET[openTicket.status]}</span></div>` : null}
      <div class="card"><h3 class="h-md" style="margin-bottom:10px">Timeline</h3><${Timeline} events=${d.events} /></div>
      ${pp.photo || dp.photo || d.pkg.photo ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px"><h3 class="h-md">Proof</h3>
        <div class="row2">${pp.photo ? html`<div><${PhotoView} photo=${pp.photo} h=${90} label="Pickup photo" /><div class="cap" style="margin-top:4px">Pickup · PIN ${pp.pinOk ? '✓' : '—'}</div></div>` : d.pkg.photo ? html`<div><${PhotoView} photo=${d.pkg.photo} h=${90} label="Package photo" /><div class="cap" style="margin-top:4px">Your package photo</div></div>` : html`<div></div>`}${dp.photo ? html`<div><${PhotoView} photo=${dp.photo} h=${90} label="Delivery photo" /><div class="cap" style="margin-top:4px">Handover${dp.ts ? ' · ' + F.time(dp.ts) : ''}</div></div>` : null}</div>
        ${d.status === 'delivered' || d.status === 'disputed' ? html`<div class="kv"><span>Received by</span><span>${dp.receiverName || d.recipient.name}</span></div><div class="kv"><span>PIN</span><span>${dp.pinOk ? '✓ confirmed by the ' + (dp.pinBy || 'recipient') : '—'}</span></div><div class="kv"><span>Signature</span><span><${SigView} value=${dp.signature} required=${d.sigRequired} /></span></div><div class="kv"><span>GPS</span><span>${dp.distM != null ? dp.distM + ' m from drop-off pin' : 'No GPS fix recorded'}</span></div><div class="kv"><span>Time</span><span>${dp.ts ? F.full(dp.ts) : '—'}</span></div>` : null}</div>` : null}
      <div class="card pad0">
        <div class="kv"><span>Recipient</span><span>${d.recipient.name} · ${F.phoneMask(d.recipient.phone)}</span></div>
        <div class="kv"><span>Route</span><span>${d.pickup.area} → ${d.dropoff.area} · ${d.price.km} km</span></div>
        <div class="kv"><span>Package</span><span>${d.pkg.desc} · ${(S.sizeOf(d.pkg.size) || {}).label} · ${d.pkg.weight} kg</span></div>
        <div class="kv"><span>Vehicle</span><span>${S.cls(d.cls).label}${r ? ' · ' + r.name + ' · ' + r.plate : ''}</span></div>
        <div class="kv"><span>Price</span><span>${F.ugx(d.price.total)} · ${S.methodLabel(V(), d.payment.method)} · ${d.payment.status.replace('_', ' ')}</span></div>
        ${d.token && D.ACTIVE.includes(d.status) ? html`<div class="kv"><span>Tracking link</span><button class="linkbtn" style="padding:0" onClick=${() => share(d)}>Copy link</button></div>` : null}
      </div>
      ${d.receipt ? html`<button class="card" style="display:flex;align-items:center;gap:12px;border:0;text-align:left" onClick=${() => go('receipt', { id: d.id })}><${Icon} n="receipt" /><span style="flex:1"><b>Receipt ${d.receipt.id}</b><div class="cap">${F.ugx(d.receipt.total)}</div></span><${Icon} n="chevR" s="18" /></button>` : null}
      ${t.report ? html`<div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Report a problem</b><div class="pills">${(d.status === 'delivered' ? [['damaged', 'Damaged or wrong'], ['other', 'Something else']] : [['late', 'Late or missing'], ['rider', 'Driver problem'], ['payment', 'Payment'], ['other', 'Something else']]).map(([k, l]) => html`<button class="pill" aria-pressed=${t.rtype === k ? 'true' : 'false'} onClick=${() => { t.rtype = k; D.rerender(); }}>${l}</button>`)}</div>
        <textarea class="input" rows="2" aria-label="Describe the problem" placeholder="What happened?" value=${t.rnote || ''} onInput=${(e) => { t.rnote = e.target.value; }}></textarea>
        <${Btn} kind="ink md" busy=${D.busy('v-report')} onClick=${() => D.run('v-report', async () => { if (!t.rtype) throw new D.UserError('Choose what went wrong.'); await act.openTicket({ did: d.id, type: t.rtype, note: t.rnote }); t.report = false; }, { dev, ok: d.status === 'delivered' && t.rtype === 'damaged' ? 'Dispute opened · ops will review the proof' : 'Support case opened' })}>Send to support<//></div>` : null}
      <div class="row2">${D.PRE_PICKUP.includes(d.status) ? html`<${Btn} kind="white md" busy=${D.busy('v-cancel2')} onClick=${() => D.run('v-cancel2', () => act.vendorCancel(d.id), { dev, ok: 'Cancelled · reserved amount released' })}>Cancel delivery<//>` : html`<${Btn} kind="white md" onClick=${() => { t.report = !t.report; D.rerender(); }}>Report a problem<//>`}<${Btn} kind="md" onClick=${() => startNew({ ...draftFrom(d), step: 'review' })}>Send again<//></div>
    </div></div>`;
  };
  S.methodLabel = (v, m) => ((v && v.methods.find((x) => x.id === m)) || {}).label || { wallet: 'Drop Off Wallet', momo: 'MTN Mobile Money', airtel: 'Airtel Money', card: 'Card', credit: 'Business credit account', internal: 'Drop Off', balance: 'Balance' }[m] || m;

  const Receipt = () => {
    const d = S.delivery(U.vendor.params.id);
    const v = V();
    if (!d || !d.receipt) return html`<div class="app light"><div class="app-scroll"><${D.Back} dev=${dev} /><${Empty} title="No receipt yet" body="A receipt is issued when the delivery is completed." /></div></div>`;
    const rc = d.receipt, r = S.rider(d.riderId);
    return html`<div class="app dark" style="background:var(--ink)"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} /><h1 style="color:#fff">Receipt</h1></div>
      <div class="card" style="background:#fff;color:var(--ink);border-radius:24px;padding:20px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;justify-content:space-between;align-items:center"><span style="display:flex;gap:8px;align-items:center"><${D.Logo} s="26" /><b class="display">Drop Off</b></span><span class="chip ok">Paid</span></div>
        <div><div class="cap">Total</div><div style="font-weight:700;font-size:32px" class="tnum">${F.ugx(rc.total)}</div><div class="cap">${rc.ts ? F.full(rc.ts) : ''} · ${S.methodLabel(v, rc.method)}</div></div>
        <div style="border-top:2px dashed var(--line);margin:0 -20px"></div>
        <div class="kv"><span>Receipt</span><span class="mono">${rc.id}</span></div><div class="kv"><span>Delivery</span><span class="mono">${d.id}</span></div><div class="kv"><span>Billed to</span><span>${v.name}</span></div><div class="kv"><span>Route</span><span>${d.pickup.area} → ${d.dropoff.area}</span></div><div class="kv"><span>Driver</span><span>${r ? r.name + ' · ' + r.plate : '—'}</span></div>
        <div style="border-top:2px dashed var(--line);margin:0 -20px"></div>
        ${rc.lines.map((l) => html`<div style="display:flex;justify-content:space-between;font-size:14px"><span>${l.label}</span><span class="tnum">${F.num(l.amount)}</span></div>`)}
        <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted)"><span>Includes VAT (18%)</span><span class="tnum">${F.num(rc.vat)}</span></div>
        <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px"><span>Total paid</span><span class="tnum">${F.ugx(rc.total)}</span></div>
        <button class="list-row" style="background:var(--mist);border-radius:14px;padding:10px 12px;border:0" onClick=${() => go('detail', { id: d.id })}><${Icon} n="shield" s="18" c="#17804F" /><span class="grow"><b>Proof of delivery attached</b></span><${Icon} n="chevR" s="16" /></button>
        <div class="cap" style="text-align:center">${d.payment.simulated ? 'Sandbox payment · no real money moved' : 'Payment reference ' + (d.payment.providerRef || '')}</div>
      </div>
    </div></div>`;
  };

  const History = () => {
    const t = U.tmpOf.vendor;
    t.f = t.f || 'all';
    const q = (t.q || '').toLowerCase();
    const groups = { all: null, active: D.ACTIVE, delivered: ['delivered'], failed: ['failed', 'disputed'], cancelled: ['cancelled'] };
    const since = { any: 0, today: new Date().setHours(0, 0, 0, 0), week: Date.now() - 7 * 864e5, month: Date.now() - 30 * 864e5 }[t.when || 'any'];
    const all = mine();
    const list = all.filter((d) => (!groups[t.f] || groups[t.f].includes(d.status)) && d.createdAt >= since && (!q || (d.id + d.pkg.desc + d.recipient.name + d.dropoff.area).toLowerCase().includes(q)));
    const byDay = {};
    list.forEach((d) => { const k = F.day(d.createdAt); (byDay[k] = byDay[k] || []).push(d); });
    return html`<div class="app light"><div class="app-scroll with-tabs">
      <h1 class="h-xl">Deliveries</h1>
      <input class="input" aria-label="Search deliveries" placeholder="Search ID, recipient, item or area" value=${t.q || ''} onInput=${(e) => { t.q = e.target.value; D.rerender(); }} />
      <div class="pills scroll">${[['all', 'All'], ['active', 'Active'], ['delivered', 'Delivered'], ['failed', 'Failed & disputed'], ['cancelled', 'Cancelled']].map(([k, l]) => html`<button class="pill" aria-pressed=${t.f === k ? 'true' : 'false'} onClick=${() => { t.f = k; D.rerender(); }}>${l} · ${all.filter((d) => !groups[k] || groups[k].includes(d.status)).length}</button>`)}</div>
      <div class="pills scroll">${[['any', 'Any date'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days']].map(([k, l]) => html`<button class="pill" aria-pressed=${(t.when || 'any') === k ? 'true' : 'false'} onClick=${() => { t.when = k; D.rerender(); }}>${l}</button>`)}</div>
      ${Object.keys(byDay).map((k) => html`<div class="eyebrow">${k}</div><div class="card pad0" style="margin-top:-6px">${byDay[k].map((d) => html`<${DeliveryRow} d=${d} />`)}</div>`)}
      ${!list.length ? html`<div class="card"><${Empty} icon="search" title=${all.length ? 'No deliveries match' : 'No deliveries yet'} body=${all.length ? 'Try a different search or filter.' : 'Your first booking will appear here.'} action=${all.length ? html`<button class="btn sm ink" onClick=${() => { t.q = ''; t.f = 'all'; t.when = 'any'; D.rerender(); }}>Clear filters</button>` : html`<button class="btn sm" onClick=${() => startNew()}>New delivery</button>`} /></div>` : null}
    </div><${Tabs} cur="history" /></div>`;
  };

  /* ---------------- money ---------------- */
  const Wallet = () => {
    const v = V(), t = U.tmpOf.vendor;
    t.tf = t.tf || 'all';
    const types = { all: null, charges: ['charge', 'invoice'], topups: ['topup'], refunds: ['refund'] };
    const txs = S.state.transactions.filter((x) => x.party === 'vendor' && x.partyId === v.id && (!types[t.tf] || types[t.tf].includes(x.type)));
    const c = v.credit, remaining = c.limit - c.used, owed = c.used - c.pending;
    return html`<div class="app light"><div class="app-scroll with-tabs">
      <div class="hdr"><h1>Wallet</h1><button class="btn sm white" onClick=${() => go('payments')}>Payment methods</button></div>
      <div class="card ink" style="border-radius:26px;padding:20px;display:flex;flex-direction:column;gap:14px">
        <div><div class="cap" style="color:#C9D6D1">Available balance</div><div class="tnum count-up" key=${v.wallet} style="font-weight:700;font-size:34px">${F.ugx(v.wallet)}</div><div class="cap" style="color:#C9D6D1">${v.walletPending ? F.ugx(v.walletPending) + ' reserved for deliveries in progress' : 'Pays for deliveries instantly'}</div></div>
        <div class="row2"><${Btn} kind="md" onClick=${() => { t.topup = true; t.amt = t.amt || 200000; t.m = t.m || D.payments.network(S.me().phone) || 'momo'; t.payId = null; t.tphone = t.tphone != null ? t.tphone : (S.me().phone || '').replace('+256 ', '0').replace(/ /g, ''); D.rerender(); }}><${Icon} n="plus" s="18" w="2.6" />Top up<//><${Btn} kind="soft md" onClick=${() => go('withdraw')}><span style="color:var(--ink)">Withdraw</span><//></div>
      </div>
      ${S.state.payments.filter((p) => p.mine && p.direction === 'collection' && ['pending', 'initiated'].includes(p.status) && p.purpose === 'topup').slice(0, 2).map((p) => html`<${D.PaymentStatus} id=${p.id} compact=${true} />`)}
      <div class="card" style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:center"><b>Business credit account</b>${c.eligible ? html`<span class="chip ok">Active</span>` : html`<span class="chip grey">After verification</span>`}</div>
        ${c.eligible ? html`<div style="height:8px;border-radius:4px;background:var(--pine-soft);overflow:hidden"><div style=${'height:8px;border-radius:4px;background:var(--ink);transition:width .5s;width:' + Math.min(100, c.limit ? (c.used / c.limit) * 100 : 0) + '%'}></div></div>
          <div class="row2" style="font-size:13px"><div><div class="cap">Used</div><b class="tnum">${F.ugx(c.used)}</b></div><div><div class="cap">Available</div><b class="tnum">${F.ugx(remaining)}</b></div><div><div class="cap">Limit</div><b class="tnum">${F.ugx(c.limit)}</b></div><div><div class="cap">Outstanding · due</div><b>${owed > 0 ? F.ugx(owed) + ' · ' + c.due : 'Nothing due'}</b></div></div>
          ${owed > 0 ? html`<${Btn} kind="ghost md" busy=${D.busy('v-inv')} onClick=${() => D.run('v-inv', () => act.payInvoice(v.id), { dev, ok: 'Invoice paid from your wallet' })}>Pay ${F.ugx(owed)} from wallet<//>` : null}
          <div class="cap">A controlled credit line for verified businesses in this MVP, not a lending product.</div>` : html`<div class="cap">Verified businesses can book now and pay monthly. <button class="linkbtn" style="padding:0;font-size:inherit" onClick=${() => go('verification')}>Verify your business</button></div>`}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline"><h2 class="h-md">Transactions</h2><button class="linkbtn" onClick=${() => go('payhistory')}>Mobile money & card</button></div>
      <div class="pills scroll">${[['all', 'All'], ['charges', 'Charges'], ['topups', 'Top-ups'], ['refunds', 'Refunds']].map(([k, l]) => html`<button class="pill" aria-pressed=${t.tf === k ? 'true' : 'false'} onClick=${() => { t.tf = k; D.rerender(); }}>${l}</button>`)}</div>
      <div class="card pad0">${txs.slice(0, 40).map((x) => html`<button class="list-row" onClick=${() => x.did && go('detail', { id: x.did })} style="cursor:${x.did ? 'pointer' : 'default'}"><span class="ibox" style=${'border-radius:50%;' + (x.amount > 0 ? 'background:var(--ok-soft)' : '')}><${Icon} n=${x.amount > 0 ? 'arrowDown' : 'arrowOut'} s="17" c=${x.amount > 0 ? '#17804F' : '#0D2B23'} /></span><span class="grow"><span class="t1" style="display:block;font-size:14px">${x.label}</span><span class="t2">${F.dayTime(x.ts)} · ${x.wallet === 'credit' ? 'Credit account' : S.methodLabel(v, x.method)}${x.status !== 'completed' ? ' · ' + x.status : ''}</span></span><b class="tnum" style=${x.amount > 0 ? 'color:var(--ok)' : ''}>${x.amount > 0 ? '+' : '−'}${F.num(Math.abs(x.amount))}</b></button>`)}
        ${!txs.length ? html`<div class="empty">No transactions in this filter.</div>` : null}</div>
    </div><${Tabs} cur="wallet" />
    ${t.topup ? html`<div class="overlay" onClick=${(e) => { if (e.target === e.currentTarget) { t.topup = false; D.rerender(); } }}><div class="sheet"><div class="grabber"></div>
      ${t.payId ? html`<h2 class="h-lg">Top up · ${F.ugx(+t.amt || 0)}</h2><${D.PaymentStatus} id=${t.payId} onRetry=${() => { t.payId = null; D.rerender(); }} />
        <${Btn} kind="ghost md" onClick=${() => { t.topup = false; D.rerender(); }}>${(S.payment(t.payId) || {}).status === 'successful' ? 'Done' : 'Close · keep waiting in the background'}<//>`
      : html`<h2 class="h-lg">Top up wallet</h2>
      <div class="pills">${[50000, 100000, 200000, 500000].map((a) => html`<button class="pill" aria-pressed=${+t.amt === a ? 'true' : 'false'} onClick=${() => { t.amt = a; D.rerender(); }}>${F.k(a)}</button>`)}</div>
      <div class="field"><label for="w-amt">Amount (UGX)</label><input id="w-amt" class="input tnum" inputmode="numeric" value=${t.amt} onInput=${(e) => { t.amt = e.target.value.replace(/\D/g, ''); D.rerender(); }} /></div>
      <div class="field"><span class="lbl">Pay with</span><div class="pills">${v.methods.filter((m) => ['momo', 'airtel', 'card'].includes(m.id)).map((m) => html`<button class="pill" aria-pressed=${t.m === m.id ? 'true' : 'false'} onClick=${() => { t.m = m.id; D.rerender(); }}><${D.NetBadge} m=${m.id} />${m.label}</button>`)}</div></div>
      ${t.m !== 'card' ? html`<div class="field"><label for="w-tphone">Number to charge</label><input id="w-tphone" class="input" inputmode="tel" value=${t.tphone} onInput=${(e) => { t.tphone = e.target.value; D.rerender(); }} /></div>` : null}
      <${D.LimitsNote} />
      ${!S.me().phoneVerified ? html`<${D.PhoneVerify} dev=${dev} title="Verify your phone to top up" />` : html`
      <${Btn} busy=${D.busy('v-top')} label="Sending request…" disabled=${!(+t.amt >= 5000)} onClick=${() => D.run('v-top', async () => { const r = await act.startTopUp(t.amt, t.m, t.m === 'card' ? null : t.tphone); t.payId = r.paymentId; })}>${t.m === 'card' ? 'Continue to card payment' : 'Send payment request · ' + F.ugx(+t.amt || 0)}<//>`}
      <div class="cap" style="text-align:center">${t.m === 'card' ? 'You enter card details on the provider\'s secure page, never in Drop Off.' : 'You approve it with your Mobile Money PIN on your phone. Drop Off never asks for your PIN.'}</div>`}
      </div></div>` : null}
    </div>`;
  };

  const Payments = () => {
    const v = V();
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} /><h1>Payment methods</h1></div>
      <div class="cap">Default for new deliveries</div>
      <div class="card pad0" role="radiogroup" aria-label="Default payment method">${v.methods.map((m) => { const sel = v.defaultMethod === m.id; return html`<button class="list-row" role="radio" aria-checked=${sel} onClick=${() => D.run('v-def', () => act.setDefaultMethod(v.id, m.id), { dev, ok: m.label + ' is now your default' })}>
        <span class="ibox"><${Icon} n=${m.id === 'wallet' ? 'wallet' : m.id === 'card' ? 'card' : m.id === 'credit' ? 'receipt' : 'phone'} s="18" /></span><span class="grow"><span class="t1" style="display:block">${m.label}</span><span class="t2">${m.id === 'wallet' ? F.ugx(v.wallet) : m.id === 'credit' ? F.ugx(v.credit.limit - v.credit.used) + ' available' : m.detail || ''}</span></span>
        <span style=${'width:22px;height:22px;border-radius:50%;box-sizing:border-box;border:' + (sel ? '7px solid var(--ink)' : '2px solid #8C9792')}></span></button>`; })}</div>
      <div class="banner info"><${Icon} n="shield" s="18" /><span>Mobile money is approved with your PIN on your own phone, and card details go only to the provider's secure page. Money is credited only after the provider confirms it.${D.payments.sandbox({ provider: S.state.settings.payment_provider || 'sandbox' }) ? ' This environment uses the payment sandbox: no real money moves.' : ''}</span></div>
      <div class="eyebrow">Your limits</div><${D.LimitsNote} />
    </div></div>`;
  };

  const Withdraw = () => {
    const v = V();
    const owner = v.ownerId === S.me().id;
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="wallet" /><h1>Withdraw</h1></div>
      ${owner ? html`<${D.CashOut} dev=${dev} balance=${v.wallet} verified=${v.verified} verifyHint="Withdrawals open once your business is verified." />`
        : html`<div class="banner mari"><${Icon} n="lock" s="18" /><span>Only the business owner can withdraw money.</span></div>`}
    </div></div>`;
  };

  const PayHistory = () => {
    const t = U.tmpOf.vendor;
    const list = S.state.payments.filter((p) => p.vendorId === V().id && p.direction !== 'internal');
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} fallback="wallet" /><h1>Mobile money & card</h1></div>
      ${t.openPay ? html`<${D.PaymentStatus} id=${t.openPay} />` : null}
      <div class="card pad0"><${D.PaymentRows} list=${list} onOpen=${(p) => { t.openPay = p.id; D.rerender(); }} /></div>
      <div class="cap">Every request, approval and provider answer is recorded. Contact support with the payment if something looks wrong.</div>
    </div></div>`;
  };

  /* ---------------- notifications, account, verification, addresses, support ---------------- */
  let markedAt = 0;
  const Notifications = () => {
    const list = S.state.notifications.filter((n) => n.aud === 'vendor');
    if (list.some((n) => !n.read) && Date.now() - markedAt > 5000) { markedAt = Date.now(); setTimeout(() => act.markRead().catch(() => {}), 1500); }
    const tone = { ok: 'var(--ok-soft)', bad: 'var(--bad-soft)', warn: 'var(--mari-soft)', money: 'var(--ok-soft)', info: 'var(--pine-soft)' };
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} /><h1>Notifications</h1></div>
      <div class="card pad0">${list.slice(0, 60).map((n) => html`<button class="list-row" style="align-items:flex-start" onClick=${() => n.did && go(D.ACTIVE.includes((S.delivery(n.did) || {}).status) ? 'track' : 'detail', { id: n.did })}>
        <span class="ibox" style=${'background:' + (tone[n.kind] || tone.info)}><${Icon} n=${n.kind === 'money' ? 'wallet' : n.kind === 'bad' ? 'alert' : n.kind === 'ok' ? 'check' : 'bell'} s="17" /></span>
        <span class="grow"><span style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:14px">${n.title}</b><span class="cap" style="white-space:nowrap">${F.dayTime(n.ts)}</span></span><span class="t2" style="display:block">${n.body}</span></span>${!n.read ? html`<span style="width:8px;height:8px;border-radius:50%;background:var(--info);margin-top:6px;flex-shrink:0"></span>` : null}</button>`)}
        ${!list.length ? html`<div class="empty">No notifications yet.</div>` : null}</div>
    </div></div>`;
  };

  const Account = () => {
    const v = V(), me = S.me();
    const row = (label, sub, to, icon) => html`<button class="list-row" onClick=${() => go(to)}><${Icon} n=${icon} /><span class="grow"><span class="t1" style="display:block;font-size:15px">${label}</span>${sub ? html`<span class="t2">${sub}</span>` : null}</span><${Icon} n="chevR" s="16" c="#5F6C67" /></button>`;
    const unread = S.state.notifications.filter((n) => n.aud === 'vendor' && !n.read).length;
    return html`<div class="app light"><div class="app-scroll with-tabs">
      <div class="hdr"><span style="width:60px;height:60px;border-radius:18px;background:var(--mari);display:flex;align-items:center;justify-content:center" class="display">${v.initials}</span><div style="flex:1;min-width:0"><h1>${v.name}</h1><div class="cap">${v.verified ? '✓ Verified' : D.VERIFY[v.verification].label} · ${v.category}</div><div class="cap" style="overflow:hidden;text-overflow:ellipsis">${me.email}</div></div></div>
      <div class="eyebrow">Pickup locations</div><div class="card pad0" style="margin-top:-6px">${v.locations.map((l) => html`<div class="list-row"><span style="width:10px;height:10px;border-radius:50%;background:var(--ink)"></span><span class="grow"><span class="t1" style="display:block;font-size:15px">${l.label}</span><span class="t2">${(S.place(l.placeId) || {}).name || ''}</span></span>${l.default ? html`<span class="chip pine">Default</span>` : null}</div>`)}${!v.locations.length ? html`<div class="empty">No pickup location yet. Contact support to add one.</div>` : null}</div>
      ${v.staff.length ? html`<div class="eyebrow">Team</div><div class="card pad0" style="margin-top:-6px">${v.staff.map((s) => html`<div class="list-row"><${Avatar} name=${s.name} s="34" /><span class="grow"><span class="t1" style="display:block;font-size:15px">${s.name}</span><span class="t2">${s.role[0].toUpperCase() + s.role.slice(1)}</span></span></div>`)}</div>` : null}
      <div class="card pad0">${row('Business verification', D.VERIFY[v.verification].label, 'verification', 'shield')}${row('Business profile', v.owner, 'profile', 'building')}${row('Notifications', unread ? unread + ' unread' : 'All caught up', 'notifications', 'bell')}${row('Saved recipients', savedRecipients().length + ' recipients', 'addresses', 'pin')}${row('Payment methods', S.methodLabel(v, v.defaultMethod) + ' by default', 'payments', 'card')}${row('Help & support', '', 'support', 'help')}</div>
      <${Btn} kind="ghost md" busy=${D.busy('signout')} onClick=${() => D.run('signout', () => D.api.signOut(), { dev: 'global' })}>Sign out<//>
    </div><${Tabs} cur="account" /></div>`;
  };

  const Profile = () => {
    const v = V(), me = S.me(), t = U.tmpOf.vendor;
    if (t.init !== v.id) Object.assign(t, { init: v.id, contact: v.owner, phone: (v.phone || '').replace('+256 ', '0'), address: v.address || '', reg: v.registrationNo || '', tin: v.tin || '' });
    const errPhone = !S.validPhone(t.phone) ? 'Enter a Ugandan mobile number.' : null;
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} /><h1>Business profile</h1></div>
      <div class="card pad0"><div class="kv"><span>Business</span><span>${v.name}</span></div><div class="kv"><span>Sign-in e-mail</span><span>${me.email}</span></div></div>
      <div class="field"><label for="p-contact">Contact person</label><input id="p-contact" class="input" value=${t.contact} onInput=${(e) => { t.contact = e.target.value; }} /></div>
      <div class="field"><label for="p-phone">Business phone</label><input id="p-phone" class=${'input' + (errPhone ? ' err' : '')} inputmode="tel" value=${t.phone} onInput=${(e) => { t.phone = e.target.value; D.rerender(); }} />${errPhone ? html`<div class="ferr">${errPhone}</div>` : null}</div>
      <div class="field"><label for="p-addr">Business address</label><input id="p-addr" class="input" value=${t.address} onInput=${(e) => { t.address = e.target.value; }} /></div>
      <div class="row2"><div class="field"><label for="p-reg">Registration no.</label><input id="p-reg" class="input" value=${t.reg} onInput=${(e) => { t.reg = e.target.value; }} /></div><div class="field"><label for="p-tin">TIN</label><input id="p-tin" class="input" value=${t.tin} onInput=${(e) => { t.tin = e.target.value; }} /></div></div>
      <div class="eyebrow">Your sign-in phone</div><${D.PhoneVerify} dev=${dev} />
    </div><div class="app-bottom"><${Btn} busy=${D.busy('v-prof')} disabled=${!!errPhone} onClick=${() => D.run('v-prof', () => act.updateProfile({ contact_name: t.contact, business_phone: t.phone, address: t.address, registration_no: t.reg, tin: t.tin, ...(S.me().name !== t.contact && !v.verified ? { full_name: t.contact } : {}) }), { dev, ok: 'Profile saved' })}>Save changes<//></div></div>`;
  };

  // Shared by the vendor and rider apps: upload documents, see the status and the reviewer's note, submit.
  D.VerificationPanel = ({ kinds, required, devName }) => {
    const me = S.me();
    const vr = S.state.verifications.find((x) => x.profileId === me.id) || { status: 'pending', documents: [] };
    const locked = ['submitted', 'under_review', 'verified', 'suspended'].includes(vr.status) && !vr.infoRequested;
    const have = new Set(vr.documents.map((d) => d.kind));
    const missing = required.filter((k) => (Array.isArray(k) ? !k.some((x) => have.has(x)) : !have.has(k)));
    const tone = D.VERIFY[vr.status];
    const isReq = (k) => required.some((r) => (Array.isArray(r) ? r.includes(k) : r === k));
    return html`<div style="display:flex;flex-direction:column;gap:14px">
      <div class="card" style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;justify-content:space-between;align-items:center"><b>Status</b><span class=${'chip ' + tone.tone}>${vr.infoRequested ? 'More information needed' : tone.label}</span></div>
        ${vr.note ? html`<div class=${'banner ' + (vr.status === 'verified' ? 'info' : 'mari')}><${Icon} n="msg" s="18" /><span><b>Note from Drop Off:</b> ${vr.note}</span></div>` : null}
        <div class="cap">${vr.status === 'verified' ? 'Verified ' + (vr.reviewedAt ? F.day(vr.reviewedAt) : '') + '. Drop Off staff checked these documents; no automated identity check was run.' : locked ? 'Submitted ' + (vr.submittedAt ? F.dayTime(vr.submittedAt) : '') + '. Ops reviews documents by hand, usually within a working day.' : 'Upload clear photos or PDFs. Files are stored privately and only Drop Off operations staff can open them.'}</div></div>
      <div class="card pad0">${kinds.map((k) => { const docs = vr.documents.filter((d) => d.kind === k); return html`<div class="list-row" style="flex-wrap:wrap">
        <${Icon} n=${docs.length ? 'check' : 'upload'} c=${docs.length ? '#17804F' : 'currentColor'} /><span class="grow"><span class="t1" style="display:block;font-size:15px">${D.DOC_KINDS[k]}${isReq(k) ? '' : ' (optional)'}</span><span class="t2">${docs.length ? docs.map((d) => d.fileName + ' · ' + d.status).join(', ') : 'Not uploaded'}</span></span>
        ${!locked ? html`<label class="btn sm white" for=${'doc-' + k} style="cursor:pointer" aria-busy=${D.busy('doc-' + k) ? 'true' : 'false'}>${D.busy('doc-' + k) ? 'Uploading…' : docs.length ? 'Add another' : 'Upload'}</label><input id=${'doc-' + k} class="sr" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange=${(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) D.run('doc-' + k, () => S.act.uploadDocument(k, f), { dev: devName, ok: D.DOC_KINDS[k] + ' uploaded' }); }} />` : null}</div>`; })}</div>
      ${!locked && vr.status !== 'verified' ? html`<${Btn} busy=${D.busy('v-submit')} disabled=${missing.length > 0} onClick=${() => D.run('v-submit', () => S.act.submitVerification(), { dev: devName, ok: 'Submitted for review' })}>${missing.length ? 'Upload the required documents to submit' : 'Submit for review'}<//>` : null}</div>`;
  };

  const Verification = () => {
    const v = V();
    return html`<div class="app light"><div class="app-scroll">
    <div class="hdr"><${D.Back} dev=${dev} /><h1>Business verification</h1></div>
    <div class="sub">Verified businesses get invoicing, a business credit line, withdrawals and higher payment limits. Ops checks the owner's identity and one business document by hand.</div>
    <div class="eyebrow">1 · Owner's phone</div><${D.PhoneVerify} dev=${dev} />
    <div class="eyebrow">2 · Owner's ID details</div><${D.KycPanel} dev=${dev} locked=${['under_review', 'verified'].includes(v.verification)} />
    <div class="eyebrow">3 · Documents</div>
    <${D.VerificationPanel} kinds=${['national_id', 'business_registration', 'trading_licence', 'tin_certificate', 'other']} required=${['national_id', ['business_registration', 'trading_licence', 'tin_certificate']]} devName="vendor" />
  </div></div>`;
  };

  const Addresses = () => {
    const t = U.tmpOf.vendor;
    const q = (t.q || '').toLowerCase();
    const list = savedRecipients().filter((r) => !q || (r.name + r.phone + r.area).toLowerCase().includes(q));
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} /><h1>Saved recipients</h1></div>
      <input class="input" aria-label="Search saved recipients" placeholder="Search name, phone or area" value=${t.q || ''} onInput=${(e) => { t.q = e.target.value; D.rerender(); }} />
      <div class="card pad0">${list.map((r) => html`<button class="list-row" onClick=${() => startNew({ dropoff: r.placeId, q: (S.place(r.placeId) || {}).name || '', rName: r.name, rPhone: r.phone.replace('+256 ', '0'), notes: r.notes || '', step: 'package' })}><${Avatar} name=${r.name} s="40" bg="#FFF1CC" /><span class="grow"><span class="t1" style="display:block">${r.name}</span><span class="t2">${F.phoneMask(r.phone)} · ${r.area} · ${r.count} deliver${r.count === 1 ? 'y' : 'ies'}</span></span><span class="chip pine">Send</span></button>`)}
        ${!list.length ? html`<div class="empty">No saved recipients${q ? ' match' : ' yet'}.</div>` : null}</div>
      <div class="cap">Recipients are saved automatically from your deliveries. Tap one to start a delivery to them.</div>
    </div></div>`;
  };

  const Support = () => {
    const t = U.tmpOf.vendor;
    const tickets = S.state.tickets.filter((x) => x.vendorId === V().id);
    return html`<div class="app light"><div class="app-scroll">
      <div class="hdr"><${D.Back} dev=${dev} /><h1>Help & support</h1></div>
      <div class="card" style="display:flex;flex-direction:column;gap:10px"><b>Open a case</b>
        <select class="input" aria-label="Delivery" value=${t.did || ''} onChange=${(e) => { t.did = e.target.value; D.rerender(); }}><option value="">Choose a delivery…</option>${mine().slice(0, 30).map((d) => html`<option value=${d.id}>${d.id} · ${d.pkg.desc} · ${D.STATUS[d.status].label}</option>`)}</select>
        <div class="pills">${[['late', 'Late or missing'], ['damaged', 'Damaged'], ['payment', 'Payments & refunds'], ['other', 'Other']].map(([k, l]) => html`<button class="pill" aria-pressed=${t.type === k ? 'true' : 'false'} onClick=${() => { t.type = k; D.rerender(); }}>${l}</button>`)}</div>
        <textarea class="input" rows="2" aria-label="Describe the problem" placeholder="Tell us what happened" value=${t.note || ''} onInput=${(e) => { t.note = e.target.value; }}></textarea>
        <${Btn} kind="ink md" busy=${D.busy('v-ticket')} onClick=${() => D.run('v-ticket', async () => { if (!t.did) throw new D.UserError('Choose the delivery this is about.'); if (!t.type) throw new D.UserError('Choose what went wrong.'); await act.openTicket({ did: t.did, type: t.type, note: t.note }); t.note = ''; t.type = null; }, { dev, ok: 'Case opened · ops will reply here' })}>Send to support<//></div>
      <div class="eyebrow">Your cases</div>
      <div class="card pad0" style="margin-top:-6px">${tickets.map((x) => html`<button class="list-row" onClick=${() => x.did && go('detail', { id: x.did })}><span class="grow"><span class="t1" style="display:block;font-size:14px">${x.title}${x.did ? ' · ' + x.did : ''}</span><span class="t2">${x.id} · ${F.dayTime(x.createdAt)}${x.resolutionNote ? ' · ' + x.resolutionNote : ''}</span></span><span class=${'chip ' + (['resolved', 'closed'].includes(x.status) ? 'ok' : 'mari')}>${D.TICKET[x.status]}</span></button>`)}
        ${!tickets.length ? html`<div class="empty">No cases yet.</div>` : null}</div>
    </div></div>`;
  };

  /* ---------------- device root ---------------- */
  D.VendorApp = () => {
    if (!V()) return html`<div class="app light"><div class="app-scroll"><${Empty} title="No business on this account" body="This account isn't linked to a business. Contact support." /></div></div>`;
    const map = { home: Home, new: Wizard, track: Track, detail: Detail, receipt: Receipt, history: History, wallet: Wallet, payments: Payments, withdraw: Withdraw, payhistory: PayHistory, notifications: Notifications, account: Account, profile: Profile, verification: Verification, addresses: Addresses, support: Support };
    const C = map[U.vendor.screen] || Home;
    return html`<${C} />`;
  };
})();
