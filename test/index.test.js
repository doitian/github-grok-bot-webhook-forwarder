import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker, { verifySignature } from '../src/index.js';

const SECRET = 'github-secret';
const KEY = 'grok-key';

async function sign(body, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return 'sha256=' + Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

function githubRequest(body, signature, path = '/hooks/main') {
  return new Request(`https://worker.example.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': 'delivery-1',
      ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
    },
    body,
  });
}

const env = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  GROK_WEBHOOKS: JSON.stringify({
    main: { url: 'https://grok.example.com/hook', key: KEY },
    other: { url: 'https://grok.example.com/hook-2', key: 'key-2' },
  }),
};

describe('verifySignature', () => {
  it('accepts a valid signature', async () => {
    const body = JSON.stringify({ hello: 'world' });
    assert.equal(await verifySignature(SECRET, new TextEncoder().encode(body), await sign(body, SECRET)), true);
  });

  it('rejects a wrong secret, malformed header, and tampered body', async () => {
    const body = JSON.stringify({ hello: 'world' });
    assert.equal(await verifySignature('other', new TextEncoder().encode(body), await sign(body, SECRET)), false);
    assert.equal(await verifySignature(SECRET, new TextEncoder().encode(body), 'sha1=abc'), false);
    assert.equal(
      await verifySignature(SECRET, new TextEncoder().encode(body + 'x'), await sign(body, SECRET)),
      false,
    );
  });
});

describe('fetch', () => {
  it('rejects requests without a valid signature with 401', async () => {
    const body = JSON.stringify({ zen: 'keep it logically awesome' });
    const res = await worker.fetch(githubRequest(body, await sign(body, 'wrong-secret')), env);
    assert.equal(res.status, 401);
  });

  it('rejects non-POST requests with 405', async () => {
    const res = await worker.fetch(new Request('https://worker.example.com/', { method: 'PUT' }), env);
    assert.equal(res.status, 405);
  });

  it('forwards a signed event to the Grok webhook named in the path', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    };
    try {
      const body = JSON.stringify({ ref: 'refs/heads/main' });
      const res = await worker.fetch(githubRequest(body, await sign(body, SECRET), '/hooks/other'), env);
      assert.equal(res.status, 200);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://grok.example.com/hook-2');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer key-2');
      assert.equal(calls[0].init.headers['X-GitHub-Event'], 'push');
      assert.equal(calls[0].init.headers['X-GitHub-Delivery'], 'delivery-1');
      assert.deepEqual(new Uint8Array(calls[0].init.body), new TextEncoder().encode(body));

      const summary = await res.json();
      assert.equal(summary.name, 'other');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns 404 for an unknown route name', async () => {
    const body = JSON.stringify({ zen: 'x' });
    const res = await worker.fetch(githubRequest(body, await sign(body, SECRET), '/hooks/nope'), env);
    assert.equal(res.status, 404);
  });

  it('returns 404 for requests without a route name', async () => {
    const body = JSON.stringify({ zen: 'x' });
    const res = await worker.fetch(githubRequest(body, await sign(body, SECRET), '/'), env);
    assert.equal(res.status, 404);
  });

  it('returns 502 when the forward fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    try {
      const body = JSON.stringify({ zen: 'x' });
      const res = await worker.fetch(githubRequest(body, await sign(body, SECRET)), env);
      assert.equal(res.status, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
