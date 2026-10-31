/* Drop Off — accounts. One simple entrance for everyone:
     phone number → 6-digit SMS code   ·   Continue with Google   ·   e-mail and password
   then a single onboarding step ("I send packages" / "I deliver") for new accounts.
   Uses Supabase Auth through DO.api. Roles are assigned by the database (complete_signup), never by the client. */
(function () {
  const D = window.DO, html = D.html, S = D.store, U = D.ui;
  const { Icon, VIcon, Btn } = D;
  const A = D.api;
  const dev = 'auth';
  const T = () => U.tmpOf.auth;
  const go = (s, p) => D.nav(dev, s, { ...U.auth.params, ...(p || {}) });
  const CATS = ['Restaurant', 'Bakery & cakes', 'Pharmacy', 'Supermarket', 'Retail & fashion', 'Electronics', 'Furniture', 'Florist', 'Online store', 'Other'];

  // the audience decides the welcome copy and the default in onboarding (business, rider or operations)
  D.authAudience = () => {
    const h = location.hash.replace('#', '');
    if (/^rider/.test(h)) return 'rider';
    if (/^ops/.test(h)) return 'ops';
    if (/^vendor/.test(h)) return 'vendor';
    return window.DO_APP_MODE === 'rider' ? 'rider' : window.DO_APP_MODE === 'ops' ? 'ops' : 'vendor';
  };
  D.authStart = () => {
    const h = location.hash.replace('#', '');
    const aud = D.authAudience();
    U.auth.stack = [];
    U.auth.screen = aud === 'ops' ? 'email' : /register|login|signin|start/.test(h) ? 'start' : 'welcome';
    U.auth.params = { aud };
  };
  const audOf = () => U.auth.params.aud || D.authAudience();

  /* ---------------- shared bits ---------------- */
  const touched = (t, k) => (t.touched = t.touched || {})[k] || t.submitted;
  const Field = ({ t, k, label, type, hint, inputmode, autocomplete, placeholder, err, mono, onBlur, prefix }) => {
    const show = err && touched(t, k);
    const input = html`<input id=${'a-' + k} class=${'input' + (mono ? ' mono' : '') + (show ? ' err' : '')} type=${type || 'text'} inputmode=${inputmode} autocomplete=${autocomplete} placeholder=${placeholder}
        value=${t[k] || ''} onInput=${(e) => { t[k] = e.target.value; if (show) D.rerender(); }} onBlur=${() => { (t.touched = t.touched || {})[k] = true; onBlur && onBlur(); D.rerender(); }} />`;
    return html`<div class="field"><label for=${'a-' + k}>${label}</label>
      ${prefix ? html`<div class="input-pre"><span>${prefix}</span>${input}</div>` : input}
      ${show ? html`<div class="ferr">${err}</div>` : hint ? html`<div class="hint">${hint}</div>` : null}</div>`;
  };
  const Brand = ({ chip }) => html`<div class="auth-brand"><${D.Logo} s="34" /><span class="display" style="font-size:22px;font-variation-settings:'wdth' 112">Drop Off</span>${chip ? html`<span class="chip auth-chip">${chip}</span>` : null}</div>`;
  const Head = ({ back }) => html`<div class="hdr">${back !== false ? html`<${D.Back} dev=${dev} fallback="welcome" />` : null}<${D.Logo} s="28" /><span class="display" style="font-size:18px">Drop Off</span></div>`;
  const NotConfigured = () => html`<div class="banner bad"><${Icon} n="alert" s="18" /><span><b>No backend configured.</b> Add your Supabase URL and anon key to <span class="mono">config.js</span> (see BACKEND.md), or start the local dev server.</span></div>`;
  const DevInbox = ({ what }) => (A.config && A.config.source === 'devserver' ? html`<div class="banner info"><${Icon} n="help" s="18" /><span>Local development: ${what} <a href=${A.config.supabaseUrl + '/dev/mailbox'} target="_blank" rel="noopener" style="text-decoration:underline">dev inbox</a>.</span></div>` : null);
  const firstErr = (e) => Object.values(e).find(Boolean);
  const GoogleG = () => html`<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;
  const Legal = () => html`<div class="cap legal">By continuing you agree to Drop Off's terms and privacy notice. We use your name, phone and documents only to run deliveries, payments and safety checks, as the Uganda Data Protection and Privacy Act 2019 requires.</div>`;

  /* ---------------- welcome ---------------- */
  const Welcome = () => {
    const rider = audOf() === 'rider';
    const points = rider ? [['shield', 'Get verified', 'Phone, ID and vehicle papers, checked by our team'], ['power', 'Go online', 'Jobs that fit your vehicle come to you'], ['wallet', 'Get paid', 'Cash out to MTN or Airtel Money']]
      : [['pin', 'Book in a minute', 'Boda to 5-tonne truck, priced before you book'], ['nav', 'Track it live', 'Real GPS and a link for your customer'], ['shield', 'Proof on arrival', 'PIN, photo and signature at every handover']];
    return html`<div class="app dark auth-hero" data-aud=${rider ? 'rider' : 'vendor'}><div class="app-scroll" style="padding-top:56px">
      <${Brand} chip=${rider ? 'Riders & drivers' : 'For business'} />
      <h1 class="h-xl hero-title">${rider ? html`Deliver for businesses.<br /><span class="accent">Get paid daily.</span>` : html`Your deliveries,<br /><span class="accent">handled.</span>`}</h1>
      <p class="sub hero-sub">${rider ? 'Jobs matched to your vehicle, digital proof at every handover and payouts to mobile money.' : 'Book a rider or driver for any order, from a pharmacy bag to a fridge. Track it live and get proof when it arrives.'}</p>
      <div class="hero-points">${points.map(([ic, a, b], i) => html`<div class="hero-point" style=${'animation-delay:' + (120 + i * 90) + 'ms'}><span class="ibox"><${Icon} n=${ic} s="18" /></span><div><b>${a}</b><div class="cap">${b}</div></div></div>`)}</div>
      ${!A.configured ? html`<${NotConfigured} />` : null}
    </div><div class="app-bottom">
      <${Btn} onClick=${() => go('start')}>${rider ? 'Apply or sign in' : 'Get started'}<//>
      <a class="linkbtn" style="text-align:center;color:var(--d-text2)" href=${D.appLink(rider ? 'vendor' : 'rider')}>${rider ? 'Sending packages? Business account' : 'Want to deliver? Drive with Drop Off'}</a>
    </div></div>`;
  };

  /* ---------------- one entrance: phone, Google or e-mail ---------------- */
  const Start = () => {
    const t = T();
    const rider = audOf() === 'rider';
    const err = !S.validPhone(t.phone) ? 'Enter a Ugandan mobile number, e.g. 0772 418 905.' : null;
    const send = () => {
      t.submitted = true;
      if (err) { D.rerender(); return; }
      D.run('a-otp', async () => { await A.sendPhoneCode(t.phone); const phone = t.phone; go('otp', { phone }); Object.assign(T(), { phone, sentAt: Date.now(), code: '' }); }, { dev });
    };
    return html`<div class=${'app ' + (rider ? 'dark' : 'light')} style=${rider ? '' : 'background:#fff'}><form class="app-scroll" onSubmit=${(e) => { e.preventDefault(); send(); }}>
      <${Head} />
      <h1 class="h-xl">${rider ? 'Apply or sign in' : 'Sign in or sign up'}</h1>
      <div class="sub" style="margin-top:-6px">Use your mobile number. We'll text you a 6-digit code. No password needed.</div>
      ${A.linkError ? html`<div class="banner bad"><${Icon} n="alert" s="18" /><span>${A.linkError}</span></div>` : null}
      <${Field} t=${t} k="phone" label="Mobile number" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="772 418 905" prefix="+256" err=${err} />
      <button type="submit" class="sr">Continue</button>
      <${Btn} kind=${rider ? '' : 'ink'} busy=${D.busy('a-otp')} label="Sending code…" onClick=${send}>Continue with phone<//>
      <div class="or"><span>or</span></div>
      ${location.protocol === 'file:' || A.local ? null /* Google blocks sign-in inside app WebViews; the Android apps use phone or e-mail */
        : html`<button type="button" class="btn white google-btn" disabled=${D.busy('a-google')} onClick=${() => D.run('a-google', () => A.signInWithGoogle(), { dev })}><${GoogleG} />Continue with Google</button>`}
      <button type="button" class="linkbtn" style=${'text-align:center' + (rider ? ';color:var(--d-text2)' : '')} onClick=${() => go('email')}>Use e-mail and password</button>
      ${A.local ? html`<div class="demo-pick"><div class="eyebrow">Or explore with a demo account</div><div class="pills">${[['rose@dropoff.test', 'Business · Mama Rose Cakes'], ['moses@dropoff.test', 'Boda rider · Moses'], ['joseph@dropoff.test', 'Car driver · Joseph'], ['ops@dropoff.test', 'Operations']]
        .map(([e, l]) => html`<button type="button" class="pill" disabled=${D.busy('a-demo')} onClick=${() => D.run('a-demo', () => A.signIn(e, 'DropOff#2026'), { dev })}>${l}</button>`)}</div>
        <div class="cap">This app version keeps its own data on this phone. Every rule, payment check and status is the real one; payments use the sandbox.</div></div>` : null}
      <${Legal} />
    </form></div>`;
  };

  const Otp = () => {
    const t = T();
    const phone = U.auth.params.phone || t.phone;
    const rider = audOf() === 'rider';
    const wait = t.sentAt ? Math.max(0, 30 - Math.round((Date.now() - t.sentAt) / 1000)) : 0;
    if (wait) setTimeout(D.rerender, 1000);
    const verify = () => {
      if (!/^\d{6}$/.test(t.code || '')) { D.toast(dev, 'Enter the 6-digit code from the SMS.', 'err'); return; }
      D.run('a-verify', async () => { await A.verifyPhoneCode(phone, t.code, 'sms'); U.tmpOf.auth = {}; }, { dev });
    };
    return html`<div class=${'app ' + (rider ? 'dark' : 'light')} style=${rider ? '' : 'background:#fff'}><div class="app-scroll">
      <${Head} />
      <h1 class="h-xl">Enter the code</h1>
      <div class="sub" style="margin-top:-6px">Sent by SMS to <b>${S.normPhone(phone)}</b>. It expires in 10 minutes.</div>
      <div class="field"><label for="a-code" class="sr">6-digit code</label>
        <input id="a-code" class="input otp big" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" value=${t.code || ''}
          onInput=${(e) => { t.code = e.target.value.replace(/\D/g, '').slice(0, 6); if (t.code.length === 6) verify(); else D.rerender(); }} /></div>
      <${Btn} kind=${rider ? '' : 'ink'} busy=${D.busy('a-verify')} label="Checking…" onClick=${verify}>Verify and continue<//>
      <div style="display:flex;justify-content:space-between"><button class="linkbtn" style=${rider ? 'color:var(--d-text2)' : ''} onClick=${() => D.back(dev, 'start')}>Change number</button>
        <button class="linkbtn" disabled=${!!wait || D.busy('a-otp')} style=${rider ? 'color:var(--d-text2)' : ''} onClick=${() => D.run('a-otp', async () => { await A.sendPhoneCode(phone); t.sentAt = Date.now(); }, { dev, ok: 'New code sent' })}>${wait ? 'Resend in ' + wait + ' s' : 'Resend code'}</button></div>
      <div class="cap">Never share this code. Drop Off staff will never ask for it.</div>
      <${D.DemoSms} phone=${phone} since=${t.sentAt} />
      <${DevInbox} what="SMS codes appear in the" />
    </div></div>`;
  };

  /* ---------------- e-mail and password ---------------- */
  const Email = () => {
    const aud = audOf();
    const t = T();
    const reg = !!t.reg && aud !== 'ops';
    const e = { email: !S.validEmail(t.email) ? 'Enter a valid e-mail address.' : null, password: reg ? S.passwordProblem(t.password) : !t.password ? 'Enter your password.' : null,
      terms: reg && !t.terms ? 'Accept the terms to continue.' : null };
    const submit = () => {
      t.submitted = true;
      if (firstErr(e)) { D.rerender(); return; }
      D.run('a-email', async () => {
        if (reg) { const out = await A.signUp(t.email, t.password, { terms: true }); if (out.needsConfirmation) go('confirm', { email: t.email }); }
        else await A.signIn(t.email, t.password);
        t.password = '';
      }, { dev });
    };
    const rider = aud === 'rider';
    return html`<div class=${'app ' + (rider ? 'dark' : 'light')} style=${rider ? '' : 'background:#fff'}><form class="app-scroll" onSubmit=${(ev) => { ev.preventDefault(); submit(); }}>
      <${Head} back=${aud !== 'ops'} />
      <h1 class="h-xl">${aud === 'ops' ? 'Operations console' : reg ? 'Create an account' : 'Sign in with e-mail'}</h1>
      <div class="sub" style="margin-top:-6px">${aud === 'ops' ? 'Staff accounts are created by an administrator.' : reg ? 'Next you choose how you use Drop Off and verify your phone.' : 'Or go back and use your phone number.'}</div>
      ${A.linkError ? html`<div class="banner bad"><${Icon} n="alert" s="18" /><span>${A.linkError}. Request a new link below.</span></div>` : null}
      <${Field} t=${t} k="email" label="E-mail" type="email" inputmode="email" autocomplete="email" err=${e.email} />
      <${Field} t=${t} k="password" label="Password" type="password" autocomplete=${reg ? 'new-password' : 'current-password'} err=${e.password} hint=${reg ? 'At least 8 characters with a number' : null} />
      ${reg ? html`<label class="check"><input type="checkbox" checked=${!!t.terms} onChange=${(ev) => { t.terms = ev.target.checked; D.rerender(); }} /><span>I agree to the terms and privacy notice</span></label>${e.terms && t.submitted ? html`<div class="ferr">${e.terms}</div>` : null}` : html`<button type="button" class="linkbtn" style="align-self:flex-start;padding:0" onClick=${() => go('forgot', { email: t.email })}>Forgot your password?</button>`}
      ${A.config.source === 'devserver' && !reg ? html`<div class="banner info"><${Icon} n="help" s="18" /><span>Local demo accounts use password <b class="mono">DropOff#2026</b>: ${aud === 'ops' ? 'ops@dropoff.test' : aud === 'rider' ? 'moses@dropoff.test (boda), joseph@dropoff.test (car)' : 'rose@dropoff.test (Mama Rose Cakes)'}. Demo phones also work with an SMS code.</span></div>` : null}
      <button type="submit" class="sr">Continue</button>
    </form><div class="app-bottom"><${Btn} busy=${D.busy('a-email')} label=${reg ? 'Creating account…' : 'Signing in…'} onClick=${submit}>${reg ? 'Create account' : 'Sign in'}<//>
      ${aud !== 'ops' ? html`<button class="linkbtn" style=${'text-align:center' + (rider ? ';color:var(--d-text2)' : '')} onClick=${() => { t.reg = !reg; t.submitted = false; D.rerender(); }}>${reg ? 'I already have an account' : 'New here? Create an account with e-mail'}</button>` : null}</div></div>`;
  };

  /* ---------------- onboarding: one step for new accounts ---------------- */
  D.Onboarding = () => {
    const me = S.me();
    let saved = null;
    try { saved = sessionStorage.getItem('dropoff-aud'); } catch (e) { /* private mode */ }
    const t = U.tmpOf.auth.ob = U.tmpOf.auth.ob || { role: D.authAudience() === 'rider' || saved === 'rider' ? 'rider' : null, name: me.name && !/^\+?\d+$/.test(me.name) ? me.name : '', phone: me.phone ? me.phone.replace('+256 ', '0').replace(/ /g, '') : '', cls: 'boda' };
    const rider = t.role === 'rider';
    const places = D.PLACES.filter((p) => S.zone(p.zone).enabled);
    const plateOk = /^U[A-Z]{2} ?\d{3}[A-Z]$/i.test((t.plate || '').trim());
    const e = {
      name: (t.name || '').trim().split(/\s+/).length < 2 ? 'Enter your first and last name.' : null,
      phone: me.phoneVerified ? null : !S.validPhone(t.phone) ? 'Enter a Ugandan mobile number, e.g. 0772 418 905.' : null,
      business: !rider && (t.business || '').trim().length < 2 ? 'Enter your business name.' : null,
      cat: !rider && !t.cat ? 'Choose what you sell.' : null,
      place: !rider && !t.place ? 'Choose where drivers collect from.' : null,
      plate: rider && !plateOk ? 'Enter a plate like UEX 219K.' : rider && t.plateTaken ? 'That plate is already registered with Drop Off.' : null,
      terms: !t.terms ? 'Accept the terms to continue.' : null
    };
    const checkPlate = async () => { if (!plateOk) return; try { t.plateTaken = !(await A.call('plate_available', { p_plate: t.plate })); } catch (err) { t.plateTaken = false; } D.rerender(); };
    const submit = async () => {
      t.submitted = true;
      if (rider) await checkPlate();
      if (firstErr(e)) { D.rerender(); D.toast('auth', firstErr(e), 'err'); return; }
      const p = rider ? { role: 'rider', full_name: t.name.trim(), phone: t.phone, vehicle_class: t.cls, plate: t.plate.trim().toUpperCase(), make: (t.make || '').trim(), terms: true }
        : { role: 'vendor', full_name: t.name.trim(), contact_name: t.name.trim(), phone: t.phone, business_name: t.business.trim(), category: t.cat, place_id: t.place, location_label: (S.place(t.place) || {}).area, terms: true };
      const ok = await D.run('ob-save', () => S.act.completeSignup(p), { dev: 'auth', ok: rider ? 'Welcome! Next: verification.' : 'Welcome to Drop Off!' });
      if (ok) U.tmpOf.auth.ob = null;
    };
    const roleCard = (id, title, body, icon) => html`<button class=${'role-card' + (t.role === id ? ' on' : '')} aria-pressed=${t.role === id ? 'true' : 'false'} onClick=${() => { t.role = id; D.rerender(); }}>
      <span class="ibox">${icon}</span><span style="flex:1;text-align:left"><b>${title}</b><span class="cap" style="display:block">${body}</span></span><span class="radio"></span></button>`;
    return html`<div class=${'app ' + (rider ? 'dark' : 'light')} style=${rider ? '' : 'background:#fff'}><div class="app-scroll">
      <div class="hdr"><${D.Logo} s="28" /><span class="display" style="font-size:18px">Drop Off</span><button class="linkbtn" style="margin-left:auto" onClick=${() => D.run('signout', () => A.signOut(), { dev: 'global' })}>Sign out</button></div>
      <h1 class="h-xl">Set up your account</h1>
      <div class="sub" style="margin-top:-6px">${me.phoneVerified ? 'Signed in with ' + me.phone + '.' : me.email ? 'Signed in as ' + me.email + '.' : ''} One step, then you're in.</div>
      <div class="roles">${roleCard('vendor', 'I send packages', 'Book riders and drivers for my business', html`<${Icon} n="building" s="20" />`)}${roleCard('rider', 'I deliver', 'Boda, car, van, pickup or truck', html`<${VIcon} c="boda" s="22" />`)}</div>
      ${t.role ? html`
        <${Field} t=${t} k="name" label="Your full name" autocomplete="name" err=${e.name} />
        ${!me.phoneVerified ? html`<${Field} t=${t} k="phone" label="Mobile number" type="tel" inputmode="tel" autocomplete="tel-national" prefix="+256" placeholder="772 418 905" err=${e.phone} hint="You'll confirm it with an SMS code before mobile money or cash-outs." />` : null}
        ${rider ? html`
          <div class="field"><span class="lbl">Vehicle</span><div class="pills">${D.CLASS_ORDER.map((c) => html`<button class="pill" aria-pressed=${t.cls === c ? 'true' : 'false'} onClick=${() => { t.cls = c; D.rerender(); }}><${VIcon} c=${c} s="16" />${S.cls(c).label}</button>`)}</div></div>
          <div class="row2"><${Field} t=${t} k="plate" label="Number plate" mono=${true} placeholder="UEX 219K" err=${e.plate} onBlur=${checkPlate} /><${Field} t=${t} k="make" label="Make & model (optional)" placeholder="Bajaj Boxer 150" /></div>
          <div class="banner mari"><${Icon} n="shield" s="18" /><span>After this, verify your phone and upload your ID, a selfie, driving permit and logbook. Ops approves you before you go online.</span></div>`
        : html`
          <${Field} t=${t} k="business" label="Business name" autocomplete="organization" err=${e.business} />
          <div class="field"><span class="lbl">What do you sell?</span><div class="pills">${CATS.map((c) => html`<button class="pill" aria-pressed=${t.cat === c ? 'true' : 'false'} onClick=${() => { t.cat = c; D.rerender(); }}>${c}</button>`)}</div>${e.cat && t.submitted ? html`<div class="ferr">${e.cat}</div>` : null}</div>
          <div class="field"><label for="ob-place">Where do drivers collect from?</label><select id="ob-place" class=${'input' + (e.place && t.submitted ? ' err' : '')} value=${t.place || ''} onChange=${(ev) => { t.place = ev.target.value; D.rerender(); }}><option value="">Choose your area…</option>${places.map((p) => html`<option value=${p.id}>${p.name} · ${p.area}</option>`)}</select>${e.place && t.submitted ? html`<div class="ferr">${e.place}</div>` : html`<div class="hint">You can add more pickup points later.</div>`}</div>`}
        <label class="check"><input type="checkbox" checked=${!!t.terms} onChange=${(ev) => { t.terms = ev.target.checked; D.rerender(); }} /><span>I agree to Drop Off's terms and privacy notice</span></label>${e.terms && t.submitted ? html`<div class="ferr">${e.terms}</div>` : null}
        <${Legal} />` : null}
    </div>${t.role ? html`<div class="app-bottom raised"><${Btn} busy=${D.busy('ob-save')} label="Setting up…" onClick=${submit}>${rider ? 'Continue to verification' : 'Start sending'}<//></div>` : null}</div>`;
  };

  /* ---------------- password reset ---------------- */
  const Forgot = () => {
    const t = T();
    const rider = audOf() === 'rider';
    if (t.email == null && U.auth.params.email) t.email = U.auth.params.email;
    const err = !S.validEmail(t.email) ? 'Enter the e-mail you signed up with.' : null;
    return html`<div class=${'app ' + (rider ? 'dark' : 'light')} style=${rider ? '' : 'background:#fff'}><div class="app-scroll">
      <${Head} />
      <h1 class="h-xl">Reset your password</h1>
      ${t.sent ? html`<div class="banner info"><${Icon} n="check" s="18" /><span>If an account uses <b>${t.email}</b>, a reset link is on its way. Open it on this device.</span></div><${DevInbox} what="reset e-mails appear in the" />`
        : html`<div class="sub" style="margin-top:-6px">We'll e-mail you a link to choose a new password. Signed up with your phone? Just sign in with an SMS code.</div><${Field} t=${t} k="email" label="E-mail" type="email" inputmode="email" autocomplete="email" err=${err} />`}
    </div><div class="app-bottom">${t.sent ? html`<${Btn} kind="ghost" onClick=${() => D.back(dev, 'email')}>Back to sign in<//>` : html`<${Btn} busy=${D.busy('a-forgot')} label="Sending…" onClick=${() => { t.submitted = true; if (err) { D.rerender(); return; } D.run('a-forgot', async () => { await A.resetPassword(t.email); t.sent = true; }, { dev }); }}>Send reset link<//>`}</div></div>`;
  };

  D.ResetPassword = () => {
    const t = U.tmpOf.auth;
    const e = { password: S.passwordProblem(t.password), confirm: t.confirm !== t.password ? 'The passwords don\'t match.' : null };
    return html`<div class="app light" style="background:#fff"><div class="app-scroll">
      <${Head} back=${false} />
      <h1 class="h-xl">Choose a new password</h1>
      <${Field} t=${t} k="password" label="New password" type="password" autocomplete="new-password" err=${e.password} hint="At least 8 characters with a number" />
      <${Field} t=${t} k="confirm" label="Confirm new password" type="password" autocomplete="new-password" err=${e.confirm} />
    </div><div class="app-bottom"><${Btn} busy=${D.busy('a-newpw')} label="Saving…" onClick=${() => { t.submitted = true; if (firstErr(e)) { D.rerender(); return; } D.run('a-newpw', async () => { await A.updatePassword(t.password); U.tmpOf.auth = {}; }, { dev: 'global', ok: 'Password updated. You are signed in.' }); }}>Save password<//></div></div>`;
  };

  const Confirm = () => html`<div class="app light" style="background:#fff"><div class="app-scroll" style="padding-top:80px;align-items:center;text-align:center">
    <span class="ibox" style="width:64px;height:64px;background:var(--mari)"><${Icon} n="msg" s="28" /></span>
    <h1 class="h-xl">Confirm your e-mail</h1><div class="sub">We sent a confirmation link to <b>${U.auth.params.email}</b>. Open it, then sign in.</div>
  </div><div class="app-bottom"><${Btn} onClick=${() => D.home(dev, 'email', { aud: U.auth.params.aud })}>Go to sign in<//></div></div>`;

  D.Suspended = () => {
    const me = S.me();
    return html`<div class="app light" style="background:#fff"><div class="app-scroll" style="padding-top:80px;align-items:center;text-align:center">
      <span class="ibox" style="width:64px;height:64px;background:var(--bad-soft);color:var(--bad)"><${Icon} n="lock" s="28" /></span>
      <h1 class="h-xl">Account suspended</h1><div class="sub">${me.statusReason ? 'Reason: ' + me.statusReason + '. ' : ''}You can't book, accept or update deliveries while the account is suspended. Contact Drop Off support to resolve it.</div>
    </div><div class="app-bottom"><${Btn} kind="ghost" onClick=${() => D.run('signout', () => A.signOut(), { dev: 'global' })}>Sign out<//></div></div>`;
  };

  D.AuthApp = () => {
    const map = { welcome: Welcome, start: Start, otp: Otp, email: Email, signin: Email, forgot: Forgot, confirm: Confirm, 'register-vendor': Start, 'register-rider': Start };
    const C = map[U.auth.screen] || Welcome;
    return html`<${C} />`;
  };
  D.appLink = (aud) => 'app.html' + location.search + '#' + aud;
})();
