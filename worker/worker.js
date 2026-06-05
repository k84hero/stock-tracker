// Cloudflare Worker — analyst proxy for Stock Tracker.
//
// Holds the real Anthropic API key as a Worker SECRET (set via the dashboard or
// `wrangler secret put`), so it never reaches the public site bundle or the repo.
// The browser calls THIS worker with a shared passphrase; the worker checks the
// passphrase, then relays the request to Anthropic with the real key attached.
// Server-to-server, so the browser-direct-access header is not needed here.
//
// Secrets this worker expects (set them, do NOT hardcode):
//   ANTHROPIC_API_KEY  — your real sk-ant-... key
//   ANALYST_PASSPHRASE — a strong passphrase you'll type once in the site's Settings

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ALLOWED_ORIGINS = [
  'https://k84hero.github.io',
  'http://127.0.0.1:8741',
  'http://localhost:8741',
];
const MAX_BODY = 300_000; // bytes — generous ceiling for a tool-loop turn

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    // gate: constant-time-ish passphrase check
    const provided = request.headers.get('X-Analyst-Auth') || '';
    if (!env.ANALYST_PASSPHRASE || !safeEqual(provided, env.ANALYST_PASSPHRASE)) {
      return json({ error: 'Unauthorized — wrong analyst passphrase.' }, 401, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'Worker is missing the ANTHROPIC_API_KEY secret.' }, 500, cors);
    }

    const body = await request.text();
    if (body.length > MAX_BODY) return json({ error: 'Request too large.' }, 413, cors);

    let upstream;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
      });
    } catch (err) {
      return json({ error: `Upstream fetch failed: ${err}` }, 502, cors);
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'content-type': 'application/json' },
    });
  },
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-analyst-auth',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

// length-leaking but value-constant comparison — fine for a personal gate
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
