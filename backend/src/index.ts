import { scanReceipt, ScanError, toClientShape } from './scan.ts';
import type { Receipt } from './scan.ts';

export interface Env {
  /** wrangler secret put ANTHROPIC_API_KEY */
  ANTHROPIC_API_KEY: string;
  /** Comma-separated origins allowed to call this Worker. */
  ALLOWED_ORIGINS?: string;
  SCAN_MODEL?: string;
  SCAN_EFFORT?: string;
  MAX_IMAGE_BYTES?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  /** Optional KV namespace; without it the limiter falls back to per-isolate. */
  RATE_LIMIT?: KVNamespace;
}

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_EFFORT = 'low';
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RATE_LIMIT = 12;

const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif'
]);

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/* Per-isolate fallback. Cloudflare runs many isolates, so this alone is weak;
   it exists so the Worker is never completely unprotected before the KV
   namespace is bound, not as the real control. */
const memoryHits = new Map<string, number[]>();

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = allowedOrigins(env);
  const headers: Record<string, string> = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body: unknown, status: number, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra }
  });
}

const fail = (message: string, status: number, cors: Record<string, string>) =>
  json({ error: { message } }, status, cors);

async function underRateLimit(env: Env, key: string): Promise<boolean> {
  const limit = Number(env.RATE_LIMIT_PER_MINUTE ?? DEFAULT_RATE_LIMIT);
  if (!isFinite(limit) || limit <= 0) return true;

  const window = Math.floor(Date.now() / 60000);
  const slot = `rl:${key}:${window}`;

  if (env.RATE_LIMIT) {
    // KV is eventually consistent, so this is a coarse ceiling rather than an
    // exact count - enough to stop a script, not a substitute for WAF rules.
    const current = Number((await env.RATE_LIMIT.get(slot)) ?? '0');
    if (current >= limit) return false;
    await env.RATE_LIMIT.put(slot, String(current + 1), { expirationTtl: 120 });
    return true;
  }

  const now = Date.now();
  const recent = (memoryHits.get(key) ?? []).filter(t => now - t < 60000);
  if (recent.length >= limit) { memoryHits.set(key, recent); return false; }
  recent.push(now);
  memoryHits.set(key, recent);
  return true;
}

/** Byte length of base64 without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type Scanner = (opts: {
  apiKey: string; model: string; effort: string;
  imageBase64: string; mediaType: MediaType;
}) => Promise<Receipt>;

export async function handleScan(
  request: Request,
  env: Env,
  scan: Scanner = scanReceipt
): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);
  if (url.pathname !== '/scan') return fail('not found.', 404, cors);
  if (request.method !== 'POST') return fail('use POST.', 405, cors);

  // CORS is browser-enforced only, so the origin is also checked here. It is
  // spoofable by a direct client; the rate limit is what bounds real abuse.
  const allowed = allowedOrigins(env);
  if (allowed.length && (!origin || !allowed.includes(origin))) {
    return fail('this origin is not allowed to use this endpoint.', 403, cors);
  }

  if (!env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set');
    return fail('the scanning service is not configured.', 500, cors);
  }

  const clientKey = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await underRateLimit(env, clientKey))) {
    return fail('too many scans from this address. Try again in a minute.', 429,
      { ...cors, 'Retry-After': '60' });
  }

  const maxBytes = Number(env.MAX_IMAGE_BYTES ?? DEFAULT_MAX_IMAGE_BYTES);
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  // Base64 inflates by ~4/3; reject on the declared size before reading.
  if (declared && declared > maxBytes * 1.4 + 1024) {
    return fail('that image is too large.', 413, cors);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('the request body was not valid JSON.', 400, cors);
  }

  const payload = body as { image?: unknown; media_type?: unknown };
  const image = typeof payload.image === 'string' ? payload.image : '';
  const mediaType = typeof payload.media_type === 'string' ? payload.media_type : '';

  if (!image) return fail('no image was sent.', 400, cors);
  if (!BASE64.test(image)) return fail('the image was not valid base64.', 400, cors);
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return fail('that image format is not supported. Use JPEG, PNG, WebP or GIF.', 415, cors);
  }
  if (base64Bytes(image) > maxBytes) return fail('that image is too large.', 413, cors);

  try {
    const receipt = await scan({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.SCAN_MODEL ?? DEFAULT_MODEL,
      effort: env.SCAN_EFFORT ?? DEFAULT_EFFORT,
      imageBase64: image,
      mediaType: mediaType as MediaType
    });
    return json(toClientShape(receipt), 200, cors);
  } catch (err) {
    if (err instanceof ScanError) return fail(err.message, err.status, cors);
    console.error('unhandled:', err);
    return fail('the scan failed unexpectedly.', 500, cors);
  }
}

/** Reset the in-isolate limiter. Tests only. */
export function __resetRateLimit(): void { memoryHits.clear(); }

export default {
  fetch: (request: Request, env: Env) => handleScan(request, env)
};
