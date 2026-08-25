// netlify/functions/generate.js
//
// Server-side proxy to the real Anthropic Messages API. Turncraft's frontend
// (static/index.html) calls this instead of window.cowork.askClaude() so the
// tool works as a standalone public web app, not just inside a Cowork/chat
// artifact binding.
//
// The API key never reaches the browser — it's read here from the
// ANTHROPIC_API_KEY environment variable (set locally in .env for `netlify
// dev`, and in the Netlify site's dashboard for production).
//
// Cost protection (this endpoint is public — anyone can call it):
//   1. Per-IP rate limiting via Netlify Blobs (see checkRateLimit below).
//   2. A hard `max_tokens` cap that the client CANNOT override — only the
//      server ever sets this value on the upstream call.
//   3. A hard spending limit set directly in the Anthropic Console. That's a
//      backstop independent of anything in this code — even if there's a bug
//      here, the bill can't run away. Set it at
//      https://console.anthropic.com/settings/limits before going live.

import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Model used for every generation call. Haiku 4.5 is the default because this
// endpoint is public and unauthenticated — it's the cheapest current model,
// which matters more here than it would behind a login. Bump to
// 'claude-sonnet-5' via the ANTHROPIC_MODEL env var if generation quality
// matters more than per-call cost for your use case; the rate limit + token
// cap + Console spending limit below still apply either way.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Hard output cap, in tokens. Turncraft's largest prompts (scenario arrays,
// 4-6 conversation turns with components) comfortably fit under this; it
// exists to bound worst-case cost per call, not to match typical usage.
const MAX_OUTPUT_TOKENS = 2048;

// Reject absurdly long prompts before they ever reach the API. Turncraft's
// own prompts (including spliced-in materials/guardrails content) run well
// under this; it's a guard against someone hitting the endpoint directly
// with a crafted oversized payload.
const MAX_PROMPT_CHARS = 24000;

// Per-IP rate limit: N requests per rolling window. Turncraft's "Generate
// all" step fires one call per scenario concurrently (typically 5-9), so the
// limit needs headroom above a single normal session, not just above a
// single call.
const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export default async (req, context) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set in the environment.');
    return json({ error: 'Server is not configured. Missing API key.' }, 500);
  }

  // Netlify sets context.ip on both `netlify dev` and production deploys.
  // Fall back to the forwarded-for header just in case.
  const ip =
    context.ip ||
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';

  const rate = await checkRateLimit(ip);
  if (!rate.allowed) {
    return json(
      { error: `Rate limit exceeded. Try again in about ${rate.retryAfterMinutes} minute(s).` },
      429,
      { 'Retry-After': String(rate.retryAfterSeconds) }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt : null;
  if (!prompt || !prompt.trim()) {
    return json({ error: 'Missing "prompt" string in request body.' }, 400);
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json({ error: `Prompt too long (max ${MAX_PROMPT_CHARS} characters).` }, 400);
  }

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  try {
    const upstream = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS, // server-enforced; the client never sets this
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Anthropic API error:', upstream.status, data);
      return json(
        { error: data?.error?.message || 'Upstream API error.' },
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    // Return in the same { content: [{ type: 'text', text: '...' }] } shape
    // the Anthropic SDK/API already uses. Turncraft's extractText() in
    // static/index.html already knows how to read this shape, so nothing
    // downstream needs to change.
    return json({ content: data.content });
  } catch (e) {
    console.error('generate.js: request to Anthropic failed:', e);
    return json({ error: 'Generation failed. Please try again.' }, 502);
  }
};

// Fixed-window per-IP counter stored in Netlify Blobs. Not perfectly precise
// at window boundaries (a burst spanning two windows can exceed the nominal
// rate briefly) but simple, cheap, and enough to stop runaway/abusive usage
// on a portfolio demo — which is the actual threat model here, not a
// production multi-tenant API.
async function checkRateLimit(ip) {
  const store = getStore('rate-limits');
  const key = `ip:${ip}`;
  const now = Date.now();

  let record = null;
  try {
    record = await store.get(key, { type: 'json' });
  } catch (e) {
    console.warn('Rate limit store read failed, allowing request:', e);
  }

  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record = { windowStart: now, count: 0 };
  }

  record.count += 1;

  if (record.count > RATE_LIMIT_MAX) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - record.windowStart);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      retryAfterMinutes: Math.max(1, Math.ceil(retryAfterMs / 60000)),
    };
  }

  try {
    await store.setJSON(key, record);
  } catch (e) {
    // If the store can't be written, fail open rather than breaking
    // generation entirely — the hard token cap and Console spending limit
    // still bound worst-case cost.
    console.warn('Rate limit store write failed:', e);
  }

  return { allowed: true };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

export const config = {
  path: '/api/generate',
};
