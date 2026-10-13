// Levanto zkAPI page: deposit ETH into the vault, get a 30-day Sage key for an
// agent from a private proof, withdraw. The note lives in this browser (SDK);
// the key goes to the agent.
import { configureBrowserSdk, zkapiClient as client, browserWalletRuntime, CHAT_SPENDING_TIER_USD } from '../../sdk/index.js';

const NETWORK = document.body.dataset.network; // 'sepolia' | 'mainnet', set at build time
const SAGE_BASE = 'https://sage.levanto.ai';
const SESSION = 'levanto-zkapi-page';
const MIN_DEPOSIT_USD = 10;
const MAX_DEPOSIT_USD = 50;
const DEPOSIT_GAS = 6_300_000n; // measured: 6.19M on mainnet and Sepolia

const $ = id => document.getElementById(id);
const el = {
  status: $('status'), walletLine: $('wallet-line'), connect: $('btn-connect'), password: $('btn-password'),
  depositUsd: $('deposit-usd'), depositQuote: $('deposit-quote'), deposit: $('btn-deposit'),
  depositTitle: $('deposit-title'), balanceView: $('balance-view'),
  balUsd: $('bal-usd'), balEth: $('bal-eth'), balExpiry: $('bal-expiry'),
  keyCap: $('key-cap'), keyTtl: $('key-ttl'), key: $('btn-key'), keyView: $('key-view'), keySum: $('key-sum'), skill: $('btn-skill'),
  reset: $('btn-reset'), withdrawTo: $('withdraw-to'), withdraw: $('btn-withdraw')
};

let busy = false;
let snap = null;
let pendingEth = null; // amount of an unfinished deposit, which must be retried as is
let issued = null; // { apiKey, expires: Date, cap } for the key shown on this page

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

// A key being settled (usually after 40 s) blocks the next action; wait for it instead of failing.
async function settled(fn) {
  const deadline = Date.now() + 3 * 60_000;
  for (;;) {
    try { return await fn(); }
    catch (error) {
      const code = error?.code || error?.errorCode;
      if (code !== 'lease_pending' || Date.now() > deadline) throw error;
      say('Settling your last key. This takes about a minute…');
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
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
  const address = s.walletAddress || client.walletAddress;
  const connected = Boolean(address);
  const note = s.wallet?.note || null;
  const hasNote = Boolean(s.wallet?.has_note && note);
  const locked = NETWORK === 'sepolia' && !client.testnetAuthenticated;
  const step = id => document.getElementById(id).classList;

  el.password.hidden = !locked;
  el.connect.disabled = busy || connected;
  el.connect.textContent = connected ? 'Connected' : 'Connect wallet';
  el.walletLine.textContent = connected ? `${short(address)} · ${NETWORK === 'sepolia' ? 'Sepolia' : 'Ethereum'}` : '';
  step('step-wallet').toggle('done', connected);

  el.depositTitle.textContent = hasNote ? 'Balance' : 'Deposit';
  el.balanceView.hidden = !hasNote;
  el.deposit.disabled = busy || !connected;
  step('step-deposit').toggle('done', hasNote);
  step('step-deposit').toggle('locked', !connected && !hasNote);
  el.balExpiry.hidden = !hasNote;
  if (hasNote) {
    el.balUsd.textContent = client.formatMoney(note.current_balance);
    el.balEth.textContent = `${trimEth(client.formatBillingAmount(note.current_balance))} ETH`;
    el.balExpiry.textContent = note.expiry_ts
      ? `Withdraw by ${new Date(Number(note.expiry_ts) * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })} (${client.formatExpiry(note.expiry_ts)} left).`
      : '';
  }

  const lease = activeLease();
  el.keySum.textContent = lease ? `Active until ${fmtDate(lease.expires)} · up to $${lease.cap}` : '';
  el.key.disabled = busy || !hasNote;
  step('step-use').toggle('locked', !hasNote);
  el.withdraw.disabled = busy || !hasNote || !connected;
  step('step-withdraw').toggle('locked', !hasNote);
}

function activeLease() {
  // After a reload the key is only in the agent's hands; the SDK still keeps its record.
  const l = snap?.config?.active_lease || browserWalletRuntime.runtime?.lease;
  const expires = l?.expires_at ? new Date(Number(l.expires_at) * 1000) : null;
  // The cap comes back via ETH and rounds to e.g. 6.000002: show whole cents.
  return expires && expires > new Date() ? { expires, cap: Math.round(Number(l.spending_limit_usd) * 100) / 100 } : null;
}
const fmtDate = d => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const trimEth = v => String(v).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');

// ---- actions ---------------------------------------------------------------------

// Network fee for a deposit at the current base fee plus a small tip, in USD.
async function depositFeeUsd(quote, usd) {
  try {
    const rpc = browserWalletRuntime.browserConfig?.trusted_deployment?.rpc_url;
    if (!rpc) return null;
    const call = async (method, params) => (await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    const block = await call('eth_getBlockByNumber', ['latest', false]);
    const feeWei = DEPOSIT_GAS * (BigInt(block.baseFeePerGas) + 100_000_000n);
    const depositWei = BigInt(quote.depositWei);
    return depositWei > 0n ? Number(feeWei * 1_000_000n / depositWei) / 1_000_000 * usd : null;
  } catch {
    return null;
  }
}

// A deposit whose MetaMask prompt was cancelled (or lost) stays recorded with its
// exact ETH amount: the SDK only retries that amount, so don't re-quote it.
async function checkPendingDeposit() {
  const pending = await browserWalletRuntime.pendingDeposit?.().catch(() => null);
  pendingEth = pending ? client.formatBillingAmount(pending.amount) : null;
  el.depositUsd.disabled = Boolean(pendingEth);
  el.deposit.textContent = pendingEth ? 'Finish deposit' : 'Deposit';
  el.reset.hidden = !pendingEth;
  if (pendingEth) el.depositQuote.textContent = `Unfinished deposit of ${trimEth(pendingEth)} ETH`;
  return pendingEth;
}

async function quoteDeposit() {
  if (await checkPendingDeposit()) return { ethAmount: pendingEth };
  const usd = Number(el.depositUsd.value);
  if (!(usd >= MIN_DEPOSIT_USD && usd <= MAX_DEPOSIT_USD)) { el.depositQuote.textContent = `Choose $${MIN_DEPOSIT_USD} to $${MAX_DEPOSIT_USD}.`; return null; }
  try {
    const quote = await client.quoteDepositUsd(String(usd));
    el.depositQuote.textContent = `≈ ${trimEth(quote.ethAmount)} ETH`;
    const fee = await depositFeeUsd(quote, usd);
    if (fee != null) el.depositQuote.textContent = `≈ ${trimEth(quote.ethAmount)} ETH + ~$${fee < 1 ? fee.toFixed(2) : fee.toFixed(1)} network fee`;
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

// Start over: drop an unfinished deposit that never reached the vault (e.g. a
// MetaMask transaction that was dropped), like clearing this site's data.
const WALLET_DB = 'zkapi-browser-wallet-v1';
const START_OVER_FLAG = 'zkapi-start-over';

el.reset.addEventListener('click', () => run('Checking the unfinished deposit…', async () => {
  const pending = await browserWalletRuntime.pendingDeposit();
  if (!pending) { await checkPendingDeposit(); say(''); return; }
  if (snap?.wallet?.has_note) throw new Error('You already have a balance here; nothing to start over.');
  const busyWithdrawal = snap?.withdrawal || (snap?.withdrawals || []).some(w =>
    ['submitted', 'submitted_late'].includes(w?.status) || (w?.mode === 'escape' && w?.status === 'confirmed'));
  if (busyWithdrawal) throw new Error('A withdrawal is still in progress. Let it finish first.');
  const note = await client.readBrowserNote(pending.next_note_id);
  if (note.status !== 0 && BigInt(note.commitment) === BigInt(pending.commitment)) {
    throw new Error('This deposit went through. Reload the page to see your balance.');
  }
  if (!window.confirm('Discard this unfinished deposit and start over?\n\nOnly do this if MetaMask shows it as failed or it was never sent. If it still went through later, that deposit would be lost.')) {
    throw new DOMException('Cancelled.', 'AbortError');
  }
  try { localStorage.setItem(START_OVER_FLAG, '1'); } catch { /* reload still retries below */ }
  location.reload();
}));

async function startOverIfRequested() {
  let requested = false;
  try { requested = localStorage.getItem(START_OVER_FLAG) === '1'; } catch { return; }
  if (!requested) return;
  await new Promise(resolve => {
    const request = indexedDB.deleteDatabase(WALLET_DB);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  try { localStorage.removeItem(START_OVER_FLAG); sessionStorage.clear(); } catch { /* ignore */ }
}

el.depositUsd.addEventListener('input', () => { clearTimeout(quoteDeposit.t); quoteDeposit.t = setTimeout(quoteDeposit, 300); });

el.deposit.addEventListener('click', () => run('Preparing your deposit…', async () => {
  const quote = await quoteDeposit();
  if (!quote) throw new Error(`Enter an amount between $${MIN_DEPOSIT_USD} and $${MAX_DEPOSIT_USD}.`);
  try {
    await client.deposit(quote.ethAmount, message => say(message));
  } finally {
    await checkPendingDeposit();
  }
  say('Deposit confirmed. Your private balance is ready.');
}));

// Right after a deposit the indexer may not have the new note yet (it polls every few seconds).
async function indexed(fn) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { return await fn(); }
    catch (error) {
      if (!/tree snapshot|stale.?root|note index/i.test(String(error?.message || error)) || Date.now() > deadline) throw error;
      say('Waiting for the deposit to be indexed…');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function acquire(cap) {
  await client.ensureTestnetAccess({ interactive: true });
  return indexed(() => settled(() => client.acquireInferenceAccess(SESSION, {
    spendingLimitUsd: cap,
    onProgress: p => { if (p?.message) say(p.message); }
  })));
}

el.key.addEventListener('click', () => run('Getting a key…', async () => {
  const cap = Number(el.keyCap.value);
  const ttl = Number(el.keyTtl.value);
  const live = activeLease();
  if (live && !(issued && issued.cap === cap && issued.ttl === ttl && issued.expires.getTime() === live.expires.getTime())
      && !window.confirm(`An agent key is active until ${fmtDate(live.expires)}. A new key ends it. Continue?`)) {
    throw new DOMException('Cancelled.', 'AbortError');
  }
  browserWalletRuntime.setRequestedLeaseTtl(ttl);
  const access = await acquire(cap);
  access.release(); // The agent calls with it, not this page.
  const lease = activeLease();
  issued = { apiKey: access.apiKey, expires: lease?.expires || new Date(Date.now() + ttl * 1000), cap, ttl };
  $('key-value').textContent = issued.apiKey;
  $('key-exp').textContent = fmtDate(issued.expires);
  el.keyView.hidden = false;
  say('Key ready.');
}));

function skillMarkdown({ apiKey, expires, cap }) {
  return `---
name: sage-private
description: Make typed decisions with Levanto Sage (yes/no, choice, score, rank, tags) using a prepaid key that can't be linked to whoever funded it. Use when you need to route, approve, block, score, rank or tag content.
---

# Sage, paid privately

You have a prepaid Sage key, funded through zkAPI. It can't be linked to the wallet that paid for it.

- Key: \`${apiKey}\`
- Base URL: ${SAGE_BASE}
- Valid until: ${expires.toISOString().replace('.000Z', 'Z')}
- Spend cap: $${cap}

Send it as \`Authorization: Bearer <key>\`. Keep it secret: anyone with it can spend the cap.
When it expires or the cap is used up, Sage answers 402: ask your human for a new key.

## Example

\`\`\`bash
curl ${SAGE_BASE}/decide \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "I was charged twice this month.", "question": {"id": "billing", "kind": "yesno", "instructions": "Is this about billing?"}}'
\`\`\`

## Everything else

Decision kinds, batching, reasoning and examples: https://docs.levanto.ai/skill.md
`;
}

el.skill.addEventListener('click', () => {
  if (!issued) return;
  const url = URL.createObjectURL(new Blob([skillMarkdown(issued)], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'SKILL.md' });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  say('Saved SKILL.md. Put it in your agent\'s skills folder.');
});

el.withdraw.addEventListener('click', () => run('Preparing your withdrawal…', async () => {
  const to = el.withdrawTo.value.trim();
  if (to && !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('That address doesn\'t look right.');
  const target = to || client.walletAddress;
  const live = activeLease() ? ' This ends the agent\'s key.' : '';
  if (!window.confirm(`Withdraw your whole balance to ${target} on ${NETWORK === 'sepolia' ? 'Sepolia' : 'Ethereum'}?${live}`)) {
    throw new DOMException('Withdrawal cancelled.', 'AbortError');
  }
  await settled(() => client.withdraw('mutual', message => say(message), to ? { destination: to } : {}));
  say('Withdrawal sent.');
}));

document.addEventListener('click', event => {
  const id = event.target?.dataset?.copy;
  if (!id) return;
  navigator.clipboard?.writeText($(id).textContent).then(() => { event.target.textContent = 'Copied'; setTimeout(() => { event.target.textContent = 'Copy'; }, 1500); });
});

// ---- boot ---------------------------------------------------------------------------

async function boot() {
  await startOverIfRequested(); // before the SDK opens the wallet database
  $('net-pill').hidden = NETWORK !== 'sepolia';
  for (const tier of CHAT_SPENDING_TIER_USD) {
    const option = document.createElement('option'); option.value = String(tier); option.textContent = `$${tier}`;
    el.keyCap.append(option);
  }
  el.keyCap.value = String(CHAT_SPENDING_TIER_USD[CHAT_SPENDING_TIER_USD.length - 1]);
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
