/* Drop Off — public website.
   The hero is a tilted 3D city block where one real delivery plays out as you scroll: booked → driver on the
   way → picked up → on the way → delivered with PIN. The scroll drives one CSS variable (--p) through a
   smoothed requestAnimationFrame loop; everything else on the page is still. Pricing and vehicle classes come
   from the database; sign-up, sign-in and tracking buttons open the real flows. */
(function () {
  const D = window.DO, html = D.html, F = D.fmt, U = D.ui;
  const { VIcon, Icon } = D;
  const T = () => (U.site = U.site || { kg: 3, km: 6, ref: '', last4: '', ref0: null });
  const appUrl = (hash) => 'app.html#' + hash;

  function loadRef() {
    const t = T();
    if (t.ref0 || t.loading) return;
    t.loading = true;
    D.api.publicRef().then((r) => { t.ref0 = r; t.loading = false; D.rerender(); }, () => { t.loading = false; t.refErr = true; D.rerender(); });
  }

  /* ---------------- the city (1000 × 1000 plane) ---------------- */
  const ROADS_V = [180, 420, 640, 860], ROADS_H = [200, 470, 720];
  const COLS = [[24, 156], [204, 396], [444, 616], [664, 836], [884, 976]], ROWS = [[24, 176], [224, 446], [494, 696], [744, 976]];
  const BUILDINGS = (() => {
    const out = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    COLS.forEach(([x0, x1], ci) => ROWS.forEach(([y0, y1], ri) => {
      if ((ci === 2 && ri === 2) || (ci === 0 && ri === 3)) return; // a park and the market square stay open
      const w = x1 - x0, h = y1 - y0;
      const n = w > 160 && h > 160 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const bw = (n === 2 ? w / 2 - 14 : w - 20) * (0.7 + rnd() * 0.3);
        const bh = h - 24 - rnd() * 40;
        out.push({ x: x0 + 10 + (n === 2 ? i * (w / 2) : 0), y: y0 + 10 + rnd() * 14, w: bw, d: bh, z: 14 + Math.round(rnd() * (ri === 1 ? 70 : 40)), tone: Math.floor(rnd() * 3) });
      }
    }));
    return out;
  })();
  const PICKUP = { x: 260, y: 720 }, DROP = { x: 760, y: 200 }, START = { x: 180, y: 980 };
  const APPROACH = `M${START.x} ${START.y} L180 720 L${PICKUP.x} 720`;
  const ROUTE = `M${PICKUP.x} 720 L420 720 L420 470 L640 470 L640 200 L${DROP.x} 200`;
  const STAGES = [
    { at: 0, title: 'Booked', body: 'Cupcakes ×12, Kisementi to Bukoto. Boda, UGX 4,000, priced before you confirm.' },
    { at: 0.14, title: 'Moses is on the way', body: 'The first matching rider accepted. You see his plate and live position.' },
    { at: 0.36, title: 'Picked up', body: 'Your pickup PIN and a photo start the record.' },
    { at: 0.5, title: 'On the way to Brian', body: 'Brian follows the same map from one SMS link. No app needed.' },
    { at: 0.9, title: 'Delivered', body: 'Brian read PIN 2640 to Moses. Photo, GPS and time are on your receipt.' }
  ];

  // Scroll → --p (0…1) with smoothing; positions the rider along the two paths without re-rendering Preact.
  function bindScene(el) {
    if (!el || el._bound) return;
    el._bound = true;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scene = el.querySelector('.city');
    const appr = el.querySelector('.path-approach'), route = el.querySelector('.path-route');
    const rider = el.querySelector('.rider'), card = el.querySelector('.stage-card');
    const la = appr.getTotalLength(), lr = route.getTotalLength();
    route.style.strokeDasharray = lr; route.style.strokeDashoffset = lr;
    let target = reduce ? 1 : 0, cur = target, raf = null, shown = -1;
    const place = (p) => {
      el.style.setProperty('--p', p.toFixed(4));
      // 0 → .32 riding to the pickup, .32 → .38 loading, .38 → .9 delivering, then parked at the door
      let pt;
      if (p < 0.32) pt = appr.getPointAtLength(la * Math.max(0, (p - 0.08) / 0.24));
      else if (p < 0.38) pt = PICKUP;
      else pt = route.getPointAtLength(lr * Math.min(1, (p - 0.38) / 0.52));
      rider.style.setProperty('--x', pt.x + 'px');
      rider.style.setProperty('--y', pt.y + 'px');
      rider.classList.toggle('hidden', p < 0.07);
      rider.classList.toggle('loaded', p >= 0.36);
      route.style.strokeDashoffset = lr * (1 - Math.min(1, Math.max(0, (p - 0.38) / 0.52)));
      scene.classList.toggle('booked', p >= 0.02);
      scene.classList.toggle('done', p >= 0.9);
      let s = 0;
      STAGES.forEach((st, i) => { if (p >= st.at) s = i; });
      if (s !== shown) {
        shown = s;
        card.dataset.stage = s;
        el.querySelectorAll('.stage-rail li').forEach((li, i) => li.classList.toggle('on', i <= s));
        el.querySelectorAll('.stage-copy').forEach((c, i) => c.classList.toggle('on', i === s));
      }
    };
    // frame-rate independent easing (~150 ms to settle), so slow or throttled frames never leave the scene behind
    let last = 0;
    const tick = (now) => {
      const dt = last ? Math.min(250, now - last) : 16;
      last = now;
      cur += (target - cur) * (1 - Math.exp(-dt / 140));
      if (Math.abs(target - cur) < 0.0005) cur = target;
      place(cur);
      if (cur !== target) raf = requestAnimationFrame(tick);
      else { raf = null; last = 0; }
    };
    const measure = () => {
      if (reduce) return;
      const r = el.getBoundingClientRect();
      const run = el.offsetHeight - window.innerHeight;
      target = run > 0 ? Math.min(1, Math.max(0, -r.top / run)) : 0;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    // fit the 1000 px city into the screen: right-hand stage on wide screens, full width under the copy on phones
    const fit = () => {
      const w = window.innerWidth, h = Math.max(620, window.innerHeight);
      const s = w < 900 ? Math.min(w / 740, h / 1100) : Math.min((w * 0.66) / 1320, h / 1120);
      el.style.setProperty('--s', s.toFixed(3));
    };
    fit();
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', () => { fit(); measure(); });
    place(cur);
    // a short first move on load so the scene reads as live before anyone scrolls
    if (!reduce) { target = 0.05; raf = requestAnimationFrame(tick); setTimeout(measure, 900); }
  }

  const Building = ({ b }) => html`<div class=${'bld t' + b.tone} style=${`--bx:${b.x}px;--by:${b.y}px;--bw:${b.w}px;--bd:${b.d}px;--bz:${b.z}px`}>
    <i class="roof"></i><i class="wall-s"></i><i class="wall-e"></i></div>`;

  const City = () => html`<div class="city">
    <div class="ground">
      <svg viewBox="0 0 1000 1000" width="1000" height="1000" aria-hidden="true">
        <rect width="1000" height="1000" fill="var(--c-ground)" />
        <rect x="444" y="494" width="172" height="202" rx="18" fill="var(--c-park)" />
        <rect x="24" y="744" width="132" height="232" rx="14" fill="var(--c-murram)" opacity=".55" />
        <path d="M0 330 C 160 300, 260 380, 420 330 S 760 300, 1000 360" fill="none" stroke="var(--c-murram)" stroke-width="10" stroke-linecap="round" opacity=".5" />
        ${ROADS_V.map((x) => html`<line x1=${x} y1="0" x2=${x} y2="1000" stroke="var(--c-road)" stroke-width="30" />`)}
        ${ROADS_H.map((y) => html`<line x1="0" y1=${y} x2="1000" y2=${y} stroke="var(--c-road)" stroke-width="30" />`)}
        ${ROADS_V.map((x) => html`<line x1=${x} y1="0" x2=${x} y2="1000" stroke="var(--c-lane)" stroke-width="2" stroke-dasharray="14 18" />`)}
        ${ROADS_H.map((y) => html`<line x1="0" y1=${y} x2="1000" y2=${y} stroke="var(--c-lane)" stroke-width="2" stroke-dasharray="14 18" />`)}
        <path class="path-approach" d=${APPROACH} fill="none" stroke="var(--c-approach)" stroke-width="6" stroke-dasharray="2 14" stroke-linecap="round" />
        <path d=${ROUTE} fill="none" stroke="var(--c-route-ghost)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" />
        <path class="path-route" d=${ROUTE} fill="none" stroke="#FFB71B" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" />
        <circle class="drop-ring" cx=${DROP.x} cy=${DROP.y} r="30" fill="none" stroke="#FFB71B" stroke-width="4" />
      </svg>
      ${BUILDINGS.map((b) => html`<${Building} b=${b} />`)}
      <div class="pin pin-pickup" style=${`--x:${PICKUP.x}px;--y:${PICKUP.y}px`}><div class="bb"><span class="pin-head"><${Icon} n="box" s="18" /></span><span class="pin-tag">Mama Rose Cakes</span></div></div>
      <div class="pin pin-drop" style=${`--x:${DROP.x}px;--y:${DROP.y}px`}><div class="bb"><span class="pin-head"><${Icon} n="pin" s="18" /></span><span class="pin-tag">Brian, Bukoto St</span><span class="pin-ok"><${Icon} n="check" s="14" w="3" />PIN 2640</span></div></div>
      <div class="rider hidden"><div class="bb"><span class="rider-shadow"></span><span class="rider-puck"><${VIcon} c="boda" s="22" color="#0D2B23" /></span><span class="rider-parcel"></span></div></div>
    </div>
  </div>`;

  /* ---------------- page ---------------- */
  D.SiteApp = () => {
    const t = T();
    loadRef();
    const ref = t.ref0;
    // vehicle by load: the smallest package size that carries the weight decides the vehicle (same rule as booking)
    const KG = [1, 3, 8, 15, 30, 60, 150, 400, 900, 2000, 5000];
    const kg = KG[Math.min(KG.length - 1, Math.max(0, t.kgi == null ? 1 : t.kgi))];
    const size = ref ? ref.sizes.slice().sort((a, b) => a.maxKg - b.maxKg).find((s) => s.maxKg >= kg) : null;
    const cls = size ? size.best : null;
    const C = ref && cls ? ref.classes.find((c) => c.id === cls) : null;
    const p = ref && cls ? ref.pricing[cls] : null;
    const km10 = Math.round(t.km * 10);
    const price = p ? Math.round(Math.max(p.min, p.base + Math.round((km10 * p.perKm) / 5000) * 500) / 500) * 500 : null;
    const track = () => D.run('site-track', async () => {
      if (!/^DO-\d+$/i.test((t.ref || '').trim())) throw new D.UserError('Enter the reference from your SMS, like DO-48233.');
      if (!/^\d{4}$/.test(t.last4 || '')) throw new D.UserError('Enter the last 4 digits of your phone.');
      const out = await D.api.call('recipient_lookup', { p_ref: t.ref.trim(), p_last4: t.last4 });
      try { sessionStorage.setItem('dropoff-rc-' + out.token, t.last4); } catch (e) { /* ignore */ }
      location.href = 'track.html?t=' + encodeURIComponent(out.token);
    }, { dev: 'global' });

    return html`<div class="w">
      <header class="w-nav"><div class="w-wrap">
        <a class="w-brand" href="index.html" aria-label="Drop Off home"><${D.Logo} s="30" /><span>Drop Off</span></a>
        <nav aria-label="Website"><a href="#load">Vehicles and prices</a><a href="#proof">Proof</a><a href="#track">Track a parcel</a><a href="#drive">Drive with us</a></nav>
        <span class="w-nav-cta"><a class="w-btn ghost" href=${appUrl('login')}>Log in</a><a class="w-btn" href=${appUrl('vendor-register')}>Get started</a></span>
      </div></header>

      <section class="w-hero" ref=${bindScene} aria-label="How a delivery moves">
        <div class="w-hero-sticky">
          <div class="w-hero-copy">
            <h1>Deliveries across Kampala, door to door.</h1>
            <p>Book a boda, car, van or truck in a minute. Follow it live, and get PIN-confirmed proof the moment it arrives.</p>
            <div class="w-ctas"><a class="w-btn big" href=${appUrl('vendor-register')}>Send your first delivery</a><a class="w-btn big ghost" href=${appUrl('rider-register')}>Become a driver</a></div>
          </div>
          <div class="w-stage" aria-hidden="true"><${City} /></div>
          <div class="stage-card" data-stage="0" role="status" aria-live="polite">
            <ol class="stage-rail">${STAGES.map((s) => html`<li><span></span></li>`)}</ol>
            ${STAGES.map((s, i) => html`<div class=${'stage-copy' + (i === 0 ? ' on' : '')}><b>${s.title}</b><span>${s.body}</span></div>`)}
            <div class="stage-ref">DO-48233</div>
          </div>
          <div class="w-scroll-hint" aria-hidden="true"><span></span>Scroll to follow the delivery</div>
        </div>
      </section>

      <section class="w-load" id="load"><div class="w-wrap w-load-grid">
        <div class="w-load-copy">
          <h2>Pick by the load. We pick the vehicle.</h2>
          <p>Tell us roughly what it weighs and how far it's going. Drop Off sends the smallest vehicle that carries it safely, at a price you see before booking.</p>
        </div>
        <div class="w-load-tool">
          <div class="w-veh" key=${cls}>
            <span class="w-veh-icon">${cls ? html`<${VIcon} c=${cls} s="88" color="#0D2B23" />` : null}</span>
            <div><b>${C ? C.long : ref ? 'Too heavy for one vehicle' : t.refErr ? 'Rates unavailable' : 'Loading rates…'}</b><span>${C ? 'Carries up to ' + F.num(C.maxKg) + ' kg' : ''}</span></div>
            <div class="w-price"><span>${price != null ? F.ugx(price) : '—'}</span><small>${p ? 'for ' + t.km + ' km' : ''}</small></div>
          </div>
          <label class="w-range"><span>Weight <b>${kg >= 1000 ? kg / 1000 + ' t' : kg + ' kg'}</b></span>
            <input type="range" min="0" max=${KG.length - 1} step="1" value=${t.kgi == null ? 1 : t.kgi} onInput=${(e) => { t.kgi = +e.target.value; D.rerender(); }} /></label>
          <label class="w-range"><span>Distance <b>${t.km} km</b></span>
            <input type="range" min="1" max="40" value=${t.km} onInput=${(e) => { t.km = +e.target.value; D.rerender(); }} /></label>
          <div class="w-classes">${(ref ? ref.classes : []).map((c) => html`<span class=${c.id === cls ? 'on' : ''}><${VIcon} c=${c.id} s="22" />${c.label}</span>`)}</div>
          <a class="w-btn" href=${appUrl('vendor-register')}>Book this delivery</a>
        </div>
      </div></section>

      <section class="w-proof" id="proof"><div class="w-wrap w-proof-grid">
        <div class="w-receipt" aria-label="Example proof of delivery">
          <div class="w-receipt-head"><${D.Logo} s="26" /><b>Delivered</b><span>10:29</span></div>
          <div class="w-receipt-photo"><span>Handover photo</span></div>
          <dl>
            <div><dt>PIN</dt><dd>Confirmed by Brian</dd></div>
            <div><dt>Location</dt><dd>9 m from the door</dd></div>
            <div><dt>Rider</dt><dd>Moses K., UEX 219K</dd></div>
            <div><dt>Paid</dt><dd>UGX 4,000, receipt RC-0206</dd></div>
          </dl>
        </div>
        <div class="w-proof-copy">
          <h2>Proof at the door, every time.</h2>
          <p>The parcel is only marked delivered when your customer gives the rider their 4-digit PIN. A photo, the GPS position and the time are filed with your receipt, so "it never arrived" has an answer.</p>
          <p>Disputes go to a person on our operations desk, who sees the same record you do.</p>
        </div>
      </div></section>

      <section class="w-track" id="track"><div class="w-wrap w-track-grid">
        <div><h2>Expecting a parcel?</h2><p>Your SMS has a tracking link. Lost it? Enter the reference and the last 4 digits of your phone.</p></div>
        <form class="w-track-form" onSubmit=${(e) => { e.preventDefault(); track(); }}>
          <label><span>Delivery reference</span><input placeholder="DO-48233" autocomplete="off" value=${t.ref} onInput=${(e) => { t.ref = e.target.value.toUpperCase(); }} /></label>
          <label><span>Last 4 digits of your phone</span><input inputmode="numeric" maxlength="4" placeholder="2640" value=${t.last4} onInput=${(e) => { t.last4 = e.target.value.replace(/\D/g, ''); }} /></label>
          <button class="w-btn" type="submit" disabled=${D.busy('site-track')}>${D.busy('site-track') ? 'Finding your parcel…' : 'Track parcel'}</button>
        </form>
      </div></section>

      <section class="w-drive" id="drive"><div class="w-wrap w-drive-grid">
        <div><h2>Own a boda, car, van or truck?</h2><p>Get jobs that fit your vehicle, cash out to MTN or Airtel Money, and reach our safety desk on every shift.</p></div>
        <div class="w-ctas"><a class="w-btn big" href=${appUrl('rider-register')}>Become a driver</a><a class="w-btn big ghost" href=${appUrl('rider')}>Driver sign-in</a></div>
      </div></section>

      <footer class="w-foot"><div class="w-wrap">
        <span class="w-brand"><${D.Logo} s="24" /><span>Drop Off</span></span>
        <nav aria-label="Footer"><a href=${appUrl('vendor')}>For businesses</a><a href=${appUrl('rider')}>For drivers</a><a href="track.html">Track a parcel</a><a href=${appUrl('ops')}>Operations</a></nav>
        <span>© 2026 Drop Off, Kampala</span>
      </div></footer>
      <div class="global-toasts">${U.toasts.global.map((x) => html`<div class=${'gtoast' + (x.kind === 'err' ? ' err' : '')} role="status" key=${x.id}>${x.body}</div>`)}</div>
    </div>`;
  };
})();
