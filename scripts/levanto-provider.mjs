// Levanto provider for the local v2 acceptance test (scripts/v2-acceptance.mjs).
//
// Same interface as that script's mockProvider ({handler, keys, events,
// failNextCreate}), but every key operation goes to a real Levanto billing
// service (its OpenRouter-compatible /zkapi/v1/keys API), and inference is a
// Sage stand-in that does what Sage serving does: authorize the key with
// billing, then report the call's usage to billing. So the acceptance run's
// settlement charges exactly what billing recorded.
//
// Use: ZKAPI_ACCEPTANCE_PROVIDER_MODULE=scripts/levanto-provider.mjs npm run test:e2e:v2
// with billing running and:
//   LEVANTO_BILLING_URL            billing base URL, e.g. http://127.0.0.1:8090
//   LEVANTO_SERVING_HMAC_SECRET    billing's SERVING_HMAC_SECRET
//   LEVANTO_MODEL_SLUG             a priced model slug in billing
//   LEVANTO_INPUT_TOKENS           input tokens reported per call; at the lease
//                                  tenant's input rate they must cost exactly the
//                                  acceptance test's MOCK_USAGE_MICRO_USD ($0.001)
// Billing's ZKAPI_MANAGEMENT_SECRET must equal the acceptance management key.
import { createHmac, randomUUID } from 'node:crypto';

const BILLING = (process.env.LEVANTO_BILLING_URL ?? '').replace(/\/$/, '');
const HMAC_SECRET = process.env.LEVANTO_SERVING_HMAC_SECRET ?? '';
const MODEL = process.env.LEVANTO_MODEL_SLUG ?? '';
const INPUT_TOKENS = Number(process.env.LEVANTO_INPUT_TOKENS ?? '0');

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
}

function respond(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
}

async function serving(path, value) {
    const body = JSON.stringify(value);
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', HMAC_SECRET).update(`${ts}.${body}`).digest('hex');
    const response = await fetch(`${BILLING}/v1/serving/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-billing-timestamp': ts, 'x-billing-signature': signature },
        body,
    });
    return { status: response.status, value: await response.json().catch(() => ({})) };
}

export function provider() {
    if (!BILLING || !HMAC_SECRET || !MODEL || !(INPUT_TOKENS > 0)) {
        throw new Error('set LEVANTO_BILLING_URL, LEVANTO_SERVING_HMAC_SECRET, LEVANTO_MODEL_SLUG and LEVANTO_INPUT_TOKENS');
    }
    const keys = new Map();
    const events = [];
    let pendingCreateFailures = 0;

    const handler = async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            const raw = await readBody(req);

            if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
                const apiKey = (req.headers.authorization ?? '').replace(/^Bearer /, '');
                const auth = await serving('authorize', { api_key: apiKey });
                if (auth.status !== 200) return respond(res, 401, { error: 'invalid API key' });
                if (!auth.value.allowed) return respond(res, 402, { error: 'lease spending limit reached' });
                const usage = await serving('usage', {
                    api_key: apiKey, idempotency_key: randomUUID(), model_slug: MODEL,
                    event_at: new Date().toISOString(), input_tokens: INPUT_TOKENS,
                });
                if (usage.status !== 200) return respond(res, 502, { error: `usage report failed: ${usage.status}` });
                const key = keys.get(auth.value.api_key_id);
                if (key) {
                    key.calls += 1;
                    key.usage_micro_usd += usage.value.cost_micro_usd;
                    events.push({ type: 'inference', hash: key.hash, usage_micro_usd: key.usage_micro_usd });
                }
                return respond(res, 200, { id: `levanto-${randomUUID()}`, object: 'chat.completion',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: INPUT_TOKENS, completion_tokens: 1, total_tokens: INPUT_TOKENS + 1 } });
            }

            if (url.pathname === '/v1/keys' && req.method === 'POST' && pendingCreateFailures > 0) {
                pendingCreateFailures--;
                events.push({ type: 'create_failed', name: JSON.parse(raw).name });
                return respond(res, 503, { error: 'injected key creation failure' });
            }

            // Key management: forwarded to billing unchanged, mirrored for the test's assertions.
            const upstream = await fetch(`${BILLING}/zkapi${url.pathname}${url.search}`, {
                method: req.method,
                headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' },
                body: raw || undefined,
            });
            const text = await upstream.text();
            const value = text ? JSON.parse(text) : {};
            const match = /^\/v1\/keys\/([0-9a-f-]+)$/.exec(url.pathname);
            if (upstream.ok && url.pathname === '/v1/keys' && req.method === 'POST') {
                const hash = value.data.hash;
                keys.set(hash, { ...value.data, key: value.key, deleted: false, usage_micro_usd: 0, calls: 0 });
                events.push({ type: 'issued', hash, limit_usd: value.data.limit });
            } else if (upstream.ok && match && keys.has(match[1])) {
                const key = keys.get(match[1]);
                if (req.method === 'PATCH') {
                    key.disabled = value.data.disabled;
                    events.push({ type: 'disabled', hash: key.hash });
                } else if (req.method === 'DELETE') {
                    key.deleted = true;
                    events.push({ type: 'deleted', hash: key.hash });
                } else if (req.method === 'GET') {
                    key.usage_micro_usd = Math.round(value.data.usage * 1_000_000);
                    events.push({ type: 'usage_read', hash: key.hash, usage_micro_usd: key.usage_micro_usd, disabled: value.data.disabled });
                }
            }
            res.writeHead(upstream.status, { 'content-type': 'application/json' });
            res.end(text);
        } catch (error) {
            respond(res, 500, { error: error.message });
        }
    };
    return { handler, keys, events, failNextCreate: () => { pendingCreateFailures++; } };
}
