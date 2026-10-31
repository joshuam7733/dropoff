/* Drop Off — shared money & identity components: payment status (approve on your phone), cash-out,
   phone verification by OTP, ID details (KYC) and limits. Used by the vendor and rider apps.
   Nothing here moves money: the server confirms every payment with the provider first. */
(function () {
  const D = window.DO, html = D.html, S = D.store, F = D.fmt, U = D.ui, A = D.api;
  const { Icon, Btn } = D;
  const act = S.act;
  const P = D.payments;

  const OPEN = ['pending', 'initiated'];
  // While a payment is waiting on the provider, refresh a little faster than the realtime safety net.
  let poll = null;
  const watchOpen = (on) => {
    if (on && !poll) poll = setInterval(() => { if (document.visibilityState === 'visible') A.refreshSoon(); }, 4000);
    if (!on && poll) { clearInterval(poll); poll = null; }
  };
  setInterval(() => watchOpen(!!(S.state && S.state.payments.some((p) => p.mine && OPEN.includes(p.status)))), 2000);

  const netBadge = (m) => html`<span class="netbadge" data-net=${m}>${m === 'momo' ? 'MTN' : m === 'airtel' ? 'airtel' : m === 'card' ? 'CARD' : m === 'wallet' ? 'WALLET' : '—'}</span>`;
  D.NetBadge = ({ m }) => netBadge(m);

  /* ---------- one payment: what the person should do now ---------- */
  D.PaymentStatus = ({ id, dark, onRetry, compact }) => {
    const p = S.payment(id);
    if (!p) return html`<div class="card pay-card"><span class="spin dark"></span><span>Preparing the payment…</span></div>`;
    const out = p.direction === 'disbursement';
    const sandbox = P.sandbox(p);
    const left = p.expiresAt ? Math.max(0, Math.round((p.expiresAt - Date.now()) / 60000)) : null;
    let tone = 'wait', title, body, actions = null;
    if (p.status === 'successful') {
      tone = 'ok';
      title = out ? 'Cash-out sent' : 'Payment received';
      body = out ? F.ugx(p.amount) + ' sent to ' + P.methodLabel(p.method) + ' ' + (p.msisdn || '') + '.' : F.ugx(p.amount) + ' confirmed by ' + P.methodLabel(p.method) + '.';
    } else if (p.status === 'failed') {
      tone = 'bad';
      title = out ? 'Cash-out failed' : 'Payment not completed';
      body = (p.failureReason || 'The provider declined it.') + (out ? ' The amount is back in your balance.' : ' Nothing was charged.');
      if (onRetry) actions = html`<${Btn} kind=${dark ? 'md' : 'ink md'} onClick=${onRetry}>Try again<//>`;
    } else if (out && p.approval === 'awaiting_approval') {
      title = 'Waiting for a quick check';
      body = p.needsReview ? 'The name on the mobile money account did not match your verified name, so ops will check it before sending.' : 'Cash-outs above ' + F.ugx((S.state.limits || {}).approvalThreshold || 500000) + ' are approved by Drop Off ops first. This usually takes a few minutes in working hours.';
    } else if (p.status === 'pending') {
      title = 'Sending to ' + P.methodLabel(p.method) + '…';
      body = 'This takes a few seconds. If it stalls, we retry automatically.';
      actions = html`<button class="linkbtn" style=${dark ? 'color:var(--d-text2)' : ''} onClick=${() => D.run('pay-retry' + id, () => act.initiatePayment(id), { dev: 'global' })}>Send again</button>`;
    } else if (out) {
      title = 'Transfer in progress';
      body = F.ugx(p.amount) + ' is on its way to ' + (p.msisdn || 'your number') + '. You get an SMS from ' + P.methodLabel(p.method) + ' when it lands.';
    } else if (p.method === 'card') {
      title = 'Finish on the secure card page';
      body = 'Card details are entered on the payment provider\'s page, never in Drop Off.';
    } else {
      title = 'Approve on your phone';
      body = 'We sent a ' + P.methodLabel(p.method) + ' prompt to ' + (p.msisdn || 'your phone') + ' for ' + F.ugx(p.amount) + '. Enter your Mobile Money PIN on the phone to approve. Never share your PIN with anyone, including Drop Off.';
    }
    const ref = p.providerRef;
    const decide = (ok) => D.run('sbx-' + p.id, () => A.sandboxDecide(ref, ok), { dev: 'global', ok: ok ? (out ? 'Transfer confirmed (sandbox)' : 'Payment approved (sandbox)') : 'Declined (sandbox)' });
    const sandboxLink = sandbox && A.local && ref && p.status === 'initiated'
      // on-device build: the "customer's phone" is drawn right here instead of a separate web page
      ? html`<div class="sbx-phone"><div class="sbx-top"><span>${out ? 'Incoming transfer' : P.methodLabel(p.method)}</span><span>sandbox</span></div>
          <div class="sbx-body">${out ? html`<b>${F.ugx(p.amount)}</b> from Drop Off to ${p.msisdn || 'your number'}` : html`Drop Off requests <b>${F.ugx(p.amount)}</b> from ${p.msisdn || 'your account'}. Enter PIN to approve.`}</div>
          <div class="sbx-actions"><${Btn} kind="sm ink" busy=${D.busy('sbx-' + p.id)} onClick=${() => decide(true)}>${out ? 'Confirm received' : 'Approve'}<//><${Btn} kind="sm white" onClick=${() => decide(false)}>${out ? 'Fail transfer' : 'Decline'}<//></div></div>`
      : sandbox && p.checkoutUrl && p.status === 'initiated'
      ? html`<a class=${'btn md ' + (dark ? '' : 'ink')} href=${p.checkoutUrl} target="_blank" rel="noopener">${out ? 'Open sandbox receiver' : p.method === 'card' ? 'Open sandbox checkout' : 'Open sandbox phone prompt'}</a>`
      : !sandbox && p.method === 'card' && p.checkoutUrl && p.status === 'initiated' ? html`<a class="btn md ink" href=${p.checkoutUrl} target="_blank" rel="noopener">Open secure card page</a>` : null;
    return html`<div class=${'card pay-card ' + tone + (compact ? ' compact' : '')} role="status" aria-live="polite">
      <div class="pay-head">${tone === 'wait' ? html`<span class="pay-pulse">${netBadge(p.method)}</span>` : html`<span class=${'pay-icon ' + tone}><${Icon} n=${tone === 'ok' ? 'check' : 'alert'} s="22" w="2.6" /></span>`}
        <div style="flex:1;min-width:0"><b>${title}</b><div class="cap">${F.ugx(p.amount)} · ${P.methodLabel(p.method)}${p.did ? ' · ' + p.did : ''}${tone === 'wait' && left != null && !out ? ' · expires in ' + left + ' min' : ''}</div></div></div>
      <div class="pay-body">${body}</div>
      ${sandbox ? html`<div class="banner mari" style="font-size:13px"><${Icon} n="shield" s="16" /><span><b>Sandbox.</b> ${out ? 'No real transfer is made. Use the button to play the mobile money network confirming it.' : 'No real ' + (p.method === 'card' ? 'card is charged' : 'prompt is sent') + " and no money moves. Use the button to play the customer's part."}</span></div>` : null}
      ${sandboxLink}${actions}</div>`;
  };

  /* ---------- payments list ---------- */
  const ST = { pending: ['Sending', 'mari'], initiated: ['Waiting', 'mari'], successful: ['Successful', 'ok'], failed: ['Failed', 'bad'], refunded: ['Refunded', 'grey'], partially_refunded: ['Part refunded', 'grey'], disputed: ['Disputed', 'bad'] };
  D.PayChip = ({ p }) => { const s = p.direction === 'disbursement' && p.approval === 'awaiting_approval' && p.status === 'pending' ? ['Needs approval', 'mari'] : ST[p.status] || [p.status, 'grey']; return html`<span class=${'chip ' + s[1]}>${s[0]}</span>`; };
  D.PaymentRows = ({ list, onOpen, dark }) => html`${list.map((p) => html`<button class="list-row" onClick=${() => onOpen && onOpen(p)}>
      ${netBadge(p.method)}<span class="grow"><span class="t1" style="display:block;font-size:14px">${p.direction === 'disbursement' ? 'Cash-out' : p.purpose === 'topup' ? 'Wallet top-up' : 'Delivery ' + (p.did || '')}</span>
      <span class="t2">${F.dayTime(p.createdAt)}${p.msisdn ? ' · ' + p.msisdn : ''}${P.sandbox(p) ? ' · sandbox' : ''}</span></span>
      <span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px"><b class="tnum">${F.ugx(p.amount)}</b><${D.PayChip} p=${p} /></span></button>`)}
    ${!list.length ? html`<div class="empty" style=${dark ? 'color:var(--d-muted)' : ''}>No mobile money or card payments yet.</div>` : null}`;

  /* ---------- limits ---------- */
  const TIER = ['Phone not verified', 'Phone verified', 'Verified ' + 'account'];
  D.LimitsNote = ({ dark, kind }) => {
    const l = S.state.limits;
    if (!l) return null;
    const pay = kind === 'payout';
    const cap = pay ? l.payoutDay : l.collectDay;
    const used = pay ? l.payoutUsed : l.collectUsed;
    return html`<div class="limits" data-dark=${dark ? '1' : null}><span class=${'tier t' + l.tier}>Level ${l.tier} · ${TIER[l.tier]}</span>
      <span class="cap">${cap ? F.ugx(Math.max(0, cap - used)) + ' left today' + (pay ? '' : ' · up to ' + F.ugx(l.collectTx) + ' per payment') : pay ? 'Cash-out opens when your account is verified' : 'Verify your phone to pay by mobile money or card'}</span></div>`;
  };

  /* ---------- on-device builds: the SMS a real phone would receive is shown in the app ---------- */
  const demoCodes = new Map();
  D.DemoSms = ({ phone, since }) => {
    if (!A.local || !phone) return null;
    const k = A.e164(phone) + ':' + (since || 0);
    const hit = demoCodes.get(k);
    if (!hit || (!hit.code && Date.now() - hit.at > 1200)) {
      demoCodes.set(k, { code: hit && hit.code, at: Date.now() });
      A.localCode(phone).then((c) => { if (c && c !== (demoCodes.get(k) || {}).code) { demoCodes.set(k, { code: c, at: Date.now() }); D.rerender(); } else if (!c) setTimeout(D.rerender, 1300); }).catch(() => {});
    }
    const code = hit && hit.code;
    return html`<div class="demo-sms" role="status"><span class="demo-sms-ic"><${Icon} n="msg" s="16" /></span><div><b>Demo SMS to ${S.normPhone(phone)}</b><div>${code ? html`Your Drop Off code is <span class="mono">${code}</span>` : 'Waiting for the code…'}</div></div></div>`;
  };

  /* ---------- phone verification (OTP) ---------- */
  D.PhoneVerify = ({ dev, dark, title }) => {
    const me = S.me();
    const t = (U.tmpOf[dev].pv = U.tmpOf[dev].pv || { step: me.phoneVerified ? 'done' : 'enter', phone: me.phone ? me.phone.replace('+256 ', '0').replace(/ /g, '') : '', code: '' });
    const send = () => D.run('pv-send', async () => {
      if (!S.validPhone(t.phone)) throw new D.UserError('Enter a Ugandan mobile number, e.g. 0772 418 905.');
      await A.changePhone(t.phone);
      t.step = 'code'; t.code = ''; t.sentAt = Date.now();
    }, { dev, ok: 'Code sent by SMS' });
    const verify = () => D.run('pv-verify', async () => {
      if (!/^\d{6}$/.test(t.code)) throw new D.UserError('Enter the 6-digit code from the SMS.');
      await A.verifyPhoneCode(t.phone, t.code, 'phone_change');
      t.step = 'done';
    }, { dev, ok: 'Phone number verified' });
    if (t.step === 'done' && me.phoneVerified) {
      return html`<div class="card verify-ok"><span class="pay-icon ok"><${Icon} n="check" s="18" w="3" /></span><div style="flex:1;min-width:0"><b>${me.phone}</b><div class="cap">Verified by SMS code${me.phoneVerifiedAt ? ' · ' + F.day(new Date(me.phoneVerifiedAt).getTime()) : ''}</div></div>
        <button class="linkbtn" style=${dark ? 'color:var(--d-text2)' : ''} onClick=${() => { t.step = 'enter'; D.rerender(); }}>Change</button></div>`;
    }
    const wait = t.sentAt ? Math.max(0, 30 - Math.round((Date.now() - t.sentAt) / 1000)) : 0;
    if (wait) setTimeout(D.rerender, 1000);
    return html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div><b>${title || (me.phoneVerified ? 'Change your phone number' : 'Verify your phone number')}</b><div class="cap">${me.phoneVerified ? 'Cash-outs pause for 24 hours after a number change, to protect your money.' : 'Needed for mobile money, cash-outs and account recovery. We send a 6-digit code by SMS.'}</div></div>
      ${t.step === 'enter' ? html`<div class="field"><label for=${dev + '-pv-phone'}>Mobile number</label><input id=${dev + '-pv-phone'} class="input" inputmode="tel" autocomplete="tel" placeholder="0772 418 905" value=${t.phone} onInput=${(e) => { t.phone = e.target.value; }} /></div>
        <${Btn} kind=${dark ? 'md' : 'ink md'} busy=${D.busy('pv-send')} label="Sending…" onClick=${send}>Send code<//>`
      : html`<div class="field"><label for=${dev + '-pv-code'}>Code sent to ${S.normPhone(t.phone)}</label><input id=${dev + '-pv-code'} class="input otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" value=${t.code} onInput=${(e) => { t.code = e.target.value.replace(/\D/g, '').slice(0, 6); if (t.code.length === 6) verify(); }} /></div>
        <${Btn} kind=${dark ? 'md' : 'ink md'} busy=${D.busy('pv-verify')} label="Checking…" onClick=${verify}>Verify<//>
        <div style="display:flex;justify-content:space-between"><button class="linkbtn" style=${dark ? 'color:var(--d-text2)' : ''} onClick=${() => { t.step = 'enter'; D.rerender(); }}>Change number</button><button class="linkbtn" disabled=${!!wait} style=${dark ? 'color:var(--d-text2)' : ''} onClick=${send}>${wait ? 'Resend in ' + wait + ' s' : 'Resend code'}</button></div>`}
      ${t.step === 'code' ? html`<${D.DemoSms} phone=${t.phone} since=${t.sentAt} />` : null}
      ${A.config && A.config.source === 'devserver' ? html`<a class="cap" href=${A.config.supabaseUrl + '/dev/mailbox'} target="_blank" rel="noopener">Local dev: codes appear in the dev inbox</a>` : null}
    </div>`;
  };

  /* ---------- identity details (KYC) ---------- */
  D.KycPanel = ({ dev, dark, locked }) => {
    const me = S.me();
    const t = (U.tmpOf[dev].kyc = U.tmpOf[dev].kyc || { nin: me.nin || '', dob: me.dob || '', edit: !me.nin });
    if (!t.edit && me.nin) {
      return html`<div class="card pad0"><div class="kv"><span>National ID (NIN)</span><span class="mono">${me.nin.slice(0, 4)}••••••${me.nin.slice(-2)}</span></div><div class="kv"><span>Date of birth</span><span>${me.dob}</span></div>
        ${locked ? html`<div class="cap" style="padding:10px 0">Locked while ops review or after verification. Contact support to correct it.</div>` : html`<button class="linkbtn" style=${'align-self:flex-start;padding:10px 0;' + (dark ? 'color:var(--d-text2)' : '')} onClick=${() => { t.edit = true; D.rerender(); }}>Edit</button>`}</div>`;
    }
    return html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
      <div class="field"><label for=${dev + '-nin'}>NIN from your National ID</label><input id=${dev + '-nin'} class="input mono" autocapitalize="characters" maxlength="16" placeholder="CM90012345ABCD" value=${t.nin} onInput=${(e) => { t.nin = e.target.value.toUpperCase(); }} /><div class="hint">14 characters, starting CM or CF. Ops compares it with the ID you upload.</div></div>
      <div class="field"><label for=${dev + '-dob'}>Date of birth</label><input id=${dev + '-dob'} class="input" type="date" max=${new Date(Date.now() - 18 * 365.25 * 864e5).toISOString().slice(0, 10)} value=${t.dob} onInput=${(e) => { t.dob = e.target.value; }} /></div>
      <${Btn} kind=${dark ? 'md' : 'ink md'} busy=${D.busy('kyc-save')} onClick=${() => D.run('kyc-save', async () => { const r = await act.saveKyc({ nin: t.nin, date_of_birth: t.dob }); t.edit = false; if (r && r.duplicate) D.toast(dev, 'This NIN is already on another account. Ops will check before approving.', 'err'); }, { dev, ok: 'ID details saved' })}>Save ID details<//>
      <div class="cap">Stored privately. Only you and Drop Off ops can see it. Drop Off does not check it with NIRA automatically.</div></div>`;
  };

  /* ---------- cash-out (rider earnings, vendor wallet withdrawal) ---------- */
  D.CashOut = ({ dev, dark, balance, verified, verifyHint }) => {
    const me = S.me();
    const t = (U.tmpOf[dev].co = U.tmpOf[dev].co || {});
    const mineOut = S.state.payments.filter((p) => p.mine && p.direction === 'disbursement');
    const open = mineOut.find((p) => OPEN.includes(p.status));
    const recent = t.last && S.payment(t.last);
    const cool = me.phoneChangedAt && Date.now() - new Date(me.phoneChangedAt).getTime() < 864e5;
    const net = P.network(me.phone);
    const amt = t.amt != null ? t.amt : String(balance || '');
    let block = null;
    if (!verified) block = verifyHint || 'Cash-out opens once ops verify your account.';
    else if (!me.phoneVerified) block = 'Verify your phone first. Cash-outs only go to your verified number.';
    else if (cool) block = 'Your number changed recently. For your security, cash-out reopens 24 hours after the change.';
    else if (!net) block = 'Your verified number is not an MTN or Airtel line.';
    return html`<div style="display:flex;flex-direction:column;gap:12px">
      ${open || recent ? html`<${D.PaymentStatus} id=${(open || recent).id} dark=${dark} />` : null}
      <div class="card" style="display:flex;flex-direction:column;gap:12px">
        <div><div class="cap">Available</div><div class="tnum count-up" key=${balance} style="font-weight:700;font-size:36px;line-height:1.1">${F.ugx(balance)}</div></div>
        <div class="dest">${netBadge(net || 'momo')}<div style="flex:1;min-width:0"><b>${P.methodLabel(net || 'momo')} ${me.phone ? F.phoneMask(me.phone) : ''}</b><div class="cap">${me.phoneVerified ? 'Your verified number · the only place cash-outs go' : 'Number not verified yet'}</div></div></div>
        <${D.LimitsNote} dark=${dark} kind="payout" />
        ${block ? html`<div class="banner mari"><${Icon} n="lock" s="18" /><span>${block}</span></div>` : html`
          <div class="field"><label for=${dev + '-co-amt'}>Amount (UGX)</label><input id=${dev + '-co-amt'} class="input tnum" inputmode="numeric" value=${amt} onInput=${(e) => { t.amt = e.target.value.replace(/\D/g, ''); D.rerender(); }} />
            <div class="hint">Minimum UGX 1,000.${(S.state.limits || {}).approvalThreshold ? ' Above ' + F.ugx(S.state.limits.approvalThreshold) + ', ops approve it first.' : ''}</div></div>
          <${Btn} kind=${dark ? '' : 'ink'} busy=${D.busy('co-send')} label="Requesting…" disabled=${!!open || !(+amt >= 1000) || +amt > balance} onClick=${() => D.run('co-send', async () => { const r = await act.cashOut(+amt); t.last = r.paymentId; t.amt = null; }, { dev, ok: 'Cash-out requested' })}>${open ? 'A cash-out is in progress' : 'Cash out ' + F.ugx(+amt || 0)}<//>`}
      </div>
      ${!me.phoneVerified ? html`<${D.PhoneVerify} dev=${dev} dark=${dark} />` : null}
      <div class="eyebrow">Cash-out history</div>
      <div class="card pad0" style="margin-top:-6px"><${D.PaymentRows} list=${mineOut} dark=${dark} onOpen=${(p) => { t.last = p.id; D.rerender(); }} /></div>
    </div>`;
  };
})();
