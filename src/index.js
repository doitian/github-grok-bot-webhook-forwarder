const SIGNATURE_PREFIX = 'sha256=';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'method not allowed' }, { status: 405 });
    }

    const route = url.pathname.match(/^\/hooks\/([A-Za-z0-9_-]+)$/);
    if (!route) {
      return Response.json({ error: 'unknown route' }, { status: 404 });
    }
    const name = route[1];

    let targets;
    try {
      targets = parseTargets(env.GROK_WEBHOOKS);
    } catch (err) {
      return Response.json({ error: `invalid GROK_WEBHOOKS config: ${err.message}` }, { status: 500 });
    }

    const target = targets.get(name);
    if (!target) {
      return Response.json({ error: `no webhook configured for "${name}"` }, { status: 404 });
    }

    // The target's Grok key doubles as the GitHub webhook secret.
    const body = await request.arrayBuffer();
    const signature = request.headers.get('X-Hub-Signature-256') ?? '';
    if (!(await verifySignature(target.key, body, signature))) {
      return Response.json({ error: 'invalid signature' }, { status: 401 });
    }

    const event = request.headers.get('X-GitHub-Event') ?? 'unknown';
    const headers = {
      'Content-Type': request.headers.get('Content-Type') ?? 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': request.headers.get('X-GitHub-Delivery') ?? 'unknown',
    };

    const result = await forward(target, body, headers);

    return Response.json(
      { name, event, ...result },
      { status: result.ok ? 200 : 502 },
    );
  },
};

export async function verifySignature(secret, body, signatureHeader) {
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, body);
  const expected = toHex(new Uint8Array(mac));
  const received = signatureHeader.slice(SIGNATURE_PREFIX.length);

  return timingSafeEqual(received, expected);
}

function parseTargets(config) {
  if (!config) throw new Error('value is empty');
  const parsed = JSON.parse(config);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('must be a JSON object mapping route names to {"url", "key"}');
  }
  const targets = new Map();
  for (const [name, target] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`name "${name}": use only letters, digits, "-" and "_"`);
    }
    if (typeof target?.url !== 'string' || !target.url.startsWith('https://')) {
      throw new Error(`"${name}": "url" must be an https:// URL`);
    }
    if (typeof target?.key !== 'string' || target.key.length === 0) {
      throw new Error(`"${name}": "key" must be a non-empty string`);
    }
    targets.set(name, target);
  }
  if (targets.size === 0) throw new Error('no webhooks configured');
  return targets;
}

async function forward(target, body, headers) {
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${target.key}` },
      body,
    });
    return { url: target.url, ok: response.ok, status: response.status };
  } catch (err) {
    return { url: target.url, ok: false, error: String(err) };
  }
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
