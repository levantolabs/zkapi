// Levanto zkAPI page: deposit ETH into the vault, get short-lived Sage keys
// from private proofs, withdraw. All wallet state lives in this browser (SDK).
import { configureBrowserSdk, zkapiClient as client, CHAT_SPENDING_TIER_USD } from '../../sdk/index.js';

const NETWORK = document.body.dataset.network; // 'sepolia' | 'mainnet', set at build time
const SAGE_MODEL = 'sage-latest'; // alias that follows Sage upgrades
const SESSION = 'levanto-zkapi-page';
const MAX_DEPOSIT_USD = 50;

const $ = id => document.getElementById(id);
const el = {
  status: $('status'), walletLine: $('wallet-line'), connect: $('btn-connect'), password: $('btn-password'),
  depositUsd: $('deposit-usd'), depositQuote: $('deposit-quote'), deposit: $('btn-deposit'),
  depositForm: $('deposit-form'), depositTitle: $('deposit-title'), balanceView: $('balance-view'),
  balUsd: $('bal-usd'), balEth: $('bal-eth'), balExpiry: $('bal-expiry'),
  ask: $('btn-ask'), tryState: $('try-state'), tryQuestion: $('try-question'), answer: $('answer'),
  keyCap: $('key-cap'), key: $('btn-key'), keyView: $('key-view'),
  withdrawTo: $('withdraw-to'), withdraw: $('btn-withdraw')
};

let busy = false;
let snap = null;

// ---- status ---------------------------------------------------------------

function say(message, { error = false } = {}) {
  el.status.textContent = message || '';
  el.status.classList.toggle('error', error);
}

function friendly(error) {
  const code = error?.code || error?.errorCode || '';
  const text = String(error?.message || error || '');
  if (error?.name === 'AbortError' || error?.isCancelled) return 'Cancelled.';
  if (/user (rejected|denied)|ACTION_REJECTED|4001/i.test(text)) return 'You cancelled the request in your wallet.';
  if (code === 'testnet_password_required' || /password/i.test(text)) return 'Enter the test password to continue.';
  if (code === 'lease_tab_conflict') return `${text.replace(/^Error:\s*/, '')} Use that tab, or come back then.`;
  if (code === 'lease_requests_in_flight') return 'A call is still running. Try again in a moment.';
  if (/failed to fetch|networkerror|load failed/i.test(text)) return 'Can\'t reach the network right now. Reload the page in a moment.';
  if (/requires at least/i.test(text)) return 'Your balance is below this spending cap. Pick a lower cap or deposit more.';
  if (text === '[object Object]') return 'Something went wrong. Try again.';
  return text.replace(/^Error:\s*/, '') || 'Something went wrong.';
}

async function run(label, fn) {
  if (busy) return;
  busy = true; render();
  say(label);
  try {
    await fn();
  } catch (error) {
    say(friendly(error), { error: true });
    console.warn('[zkapi]', error?.code || '', error?.message || error);
  } finally {
    busy = false; render();
  }
}

// ---- password (Sepolia only) -------------------------------------------------

function requestTestnetPassword({ authenticate, signal }) {
  const dialog = $('pw-dialog'), form = $('pw-form'), input = $('pw-input'), err = $('pw-error');
  return new Promise((resolve, reject) => {
    err.hidden = true; input.value = '';
    const done = (fn, value) => { cleanup(); dialog.close(); fn(value); };
    const onSubmit = async event => {
      event.preventDefault();
      try { await authenticate(input.value, { signal }); done(resolve); }
      catch (error) { if (error?.name === 'AbortError') return done(reject, error); err.hidden = false; input.select(); }
    };
    const onCancel = () => done(reject, new DOMException('Password entry cancelled.', 'AbortError'));
    const onAbort = () => done(reject, new DOMException('Password entry aborted.', 'AbortError'));
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit); $('pw-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel); signal?.removeEventListener('abort', onAbort);
    };
    form.addEventListener('submit', onSubmit); $('pw-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel); signal?.addEventListener('abort', onAbort, { once: true });
    dialog.showModal(); input.focus();
  });
}

// ---- render -------------------------------------------------------------------

const short = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function render() {
  const s = snap || {};
  const connected = Boolean(s.walletAddress || client.walletAddress);
  const note = s.wallet?.note || null;
  const hasNote = Boolean(s.wallet?.has_note && note);
  const locked = NETWORK === 'sepolia' && !client.testnetAuthenticated;

  el.password.hidden = !locked;
  el.connect.textContent = connected ? 'Connected' : 'Connect wallet';
  el.connect.disabled = busy || connected;
  el.walletLine.textContent = connected
    ? `${short(s.walletAddress || client.walletAddress)} on ${NETWORK === 'sepolia' ? 'Sepolia' : 'Ethereum'}`
    : 'Connect the wallet you\'ll deposit from.';
  $('step-wallet').classList.toggle('done', connected);

  el.depositForm.hidden = hasNote;
  el.balanceView.hidden = !hasNote;
  el.depositTitle.textContent = hasNote ? 'Balance' : 'Deposit';
  el.deposit.disabled = busy || !connected;
  $('step-deposit').classList.toggle('done', hasNote);
  $('step-deposit').classList.toggle('locked', !connected && !hasNote);
  if (hasNote) {
    el.balUsd.textContent = client.formatMoney(note.current_balance);
    el.balEth.textContent = `${trimEth(client.formatBillingAmount(note.current_balance))} ETH`;
    el.balExpiry.textContent = note.expiry_ts
      ? `Withdraw by ${new Date(Number(note.expiry_ts) * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })} (${client.formatExpiry(note.expiry_ts)} left).`
      : '';
  }

  el.ask.disabled = busy || !hasNote;
  el.key.disabled = busy || !hasNote;
  $('step-use').classList.toggle('locked', !hasNote);
  el.withdraw.disabled = busy || !hasNote || !connected;
  $('step-withdraw').classList.toggle('locked', !hasNote);
}

const trimEth = v => String(v).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');

// ---- actions ---------------------------------------------------------------------

async function quoteDeposit() {
  const usd = Number(el.depositUsd.value);
  if (!(usd >= 1 && usd <= MAX_DEPOSIT_USD)) { el.depositQuote.textContent = `Choose $1 to $${MAX_DEPOSIT_USD}.`; return null; }
  try {
    const quote = await client.quoteDepositUsd(String(usd));
    el.depositQuote.textContent = `≈ ${trimEth(quote.ethAmount)} ETH`;
    return quote;
  } catch (error) {
    el.depositQuote.textContent = error?.code === 'testnet_password_required' ? 'Enter the test password to see the ETH amount.' : '';
    return null;
  }
}

el.password.addEventListener('click', () => run('Checking access…', async () => {
  await client.ensureTestnetAccess({ interactive: true });
  await quoteDeposit();
  say('');
}));

el.connect.addEventListener('click', () => run('Waiting for your wallet…', async () => {
  await client.connectWallet();
  say('');
}));

el.depositUsd.addEventListener('input', () => { clearTimeout(quoteDeposit.t); quoteDeposit.t = setTimeout(quoteDeposit, 300); });

el.deposit.addEventListener('click', () => run('Preparing your deposit…', async () => {
  const quote = await quoteDeposit();
  if (!quote) throw new Error('Enter an amount between $1 and $50.');
  await client.deposit(quote.ethAmount, message => say(message));
  say('Deposit confirmed. Your private balance is ready.');
}));

function tabs() {
  for (const button of document.querySelectorAll('[role="tab"]')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[role="tab"]')) other.setAttribute('aria-selected', String(other === button));
      for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== button.dataset.tab;
    });
  }
}

async function acquire(cap) {
  await client.ensureTestnetAccess({ interactive: true });
  return client.acquireInferenceAccess(SESSION, {
    spendingLimitUsd: cap,
    onProgress: p => { if (p?.message) say(p.message); }
  });
}

el.ask.addEventListener('click', () => run('Getting a private key…', async () => {
  const access = await acquire(Number(el.keyCap.value) || CHAT_SPENDING_TIER_USD[0]);
  let response, body;
  try {
    say('Asking Sage…');
    response = await fetch(`${access.baseUrl}/systemone`, {
      method: 'POST',
      headers: { authorization: access.headers.authorization, 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({
        state: el.tryState.value.trim(),
        model: SAGE_MODEL,
        questions: { q: { type: 'noul', instructions: el.tryQuestion.value.trim(), criteria: { true: 'yes', false: 'no' } } }
      })
    });
    body = await response.json().catch(() => ({}));
  } finally {
    access.release();
  }
  if (response.status === 402) throw new Error('This key is used up or expired. Ask again for a new one.');
  if (!response.ok) {
    const detail = Array.isArray(body?.detail) ? body.detail.map(d => d?.msg).filter(Boolean).join('; ') : body?.detail;
    throw new Error(detail || `Sage returned ${response.status}.`);
  }
  const p = Number(body?.answers?.q?.noul);
  const tokens = body?.usage?.input_tokens;
  el.answer.hidden = false;
  el.answer.innerHTML = '';
  const verdict = document.createElement('span'); verdict.className = 'verdict'; verdict.textContent = p >= 0.5 ? 'Yes' : 'No';
  const meta = document.createElement('span'); meta.className = 'meta';
  meta.textContent = `confidence ${(Math.max(p, 1 - p) * 100).toFixed(0)}%${tokens ? ` · ${tokens} tokens` : ''}`;
  el.answer.append(verdict, meta);
  say('Charged from your private balance when the key settles.');
}));

el.key.addEventListener('click', () => run('Getting a private key…', async () => {
  const access = await acquire(Number(el.keyCap.value));
  access.release(); // The page doesn't call with it; the key stays valid until it expires.
  const lease = client.snapshot?.()?.config?.active_lease || snap?.config?.active_lease;
  const expires = lease?.expires_at ? new Date(Number(lease.expires_at) * 1000) : null;
  $('key-value').textContent = access.apiKey;
  $('key-base').textContent = access.baseUrl;
  $('key-exp').textContent = expires ? expires.toLocaleTimeString(undefined, { timeStyle: 'short' }) : '—';
  $('key-curl').textContent = [
    `curl ${access.baseUrl}/systemone \\`,
    `  -H "Authorization: Bearer ${access.apiKey}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"state":"I was charged twice.","model":"${SAGE_MODEL}","questions":{"billing":{"type":"noul","instructions":"Is this about billing?","criteria":{"true":"payments","false":"anything else"}}}}'`
  ].join('\n');
  el.keyView.hidden = false;
  say('Key ready. Keep this tab open until it expires so your balance settles.');
}));

el.withdraw.addEventListener('click', () => run('Preparing your withdrawal…', async () => {
  const to = el.withdrawTo.value.trim();
  if (to && !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('That address doesn\'t look right.');
  const target = to || client.walletAddress;
  if (!window.confirm(`Withdraw your whole balance to ${target} on ${NETWORK === 'sepolia' ? 'Sepolia' : 'Ethereum'}?`)) {
    throw new DOMException('Withdrawal cancelled.', 'AbortError');
  }
  await client.withdraw('mutual', message => say(message), to ? { destination: to } : {});
  say('Withdrawal sent.');
}));

document.addEventListener('click', event => {
  const id = event.target?.dataset?.copy;
  if (!id) return;
  navigator.clipboard?.writeText($(id).textContent).then(() => { event.target.textContent = 'Copied'; setTimeout(() => { event.target.textContent = 'Copy'; }, 1500); });
});

// ---- boot ---------------------------------------------------------------------------

async function boot() {
  $('net-pill').hidden = NETWORK !== 'sepolia';
  for (const tier of CHAT_SPENDING_TIER_USD) {
    const option = document.createElement('option'); option.value = String(tier); option.textContent = `$${tier}`;
    el.keyCap.append(option);
  }
  tabs();
  configureBrowserSdk({
    configUrl: '/zkapi/browser-config.json',
    workerUrl: '/zkapi/assets/zkapiWasmWorker.js',
    ...(NETWORK === 'sepolia' ? { requestTestnetPassword } : {})
  });
  render();
  say('Loading…');
  try {
    snap = await client.init();
    client.subscribe(next => { snap = next; render(); });
    say('');
    if (NETWORK !== 'sepolia') await quoteDeposit();
  } catch (error) {
    say(friendly(error), { error: true });
  }
  render();
}

boot();
