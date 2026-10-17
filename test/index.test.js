import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker, { verifySignature } from '../src/index.js';

const KEY = 'grok-key';
const KEY_2 = 'grok-key-2';

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
  GROK_WEBHOOKS: JSON.stringify({
    main: { url: 'https://grok.example.com/hook-1', key: KEY },
    other: { url: 'https://grok.example.com/hook-2', key: KEY_2 },
  }),
};

describe('verifySignature', () => {
  it('accepts a valid signature', async () => {
    const body = JSON.stringify({ hello: 'world' });
    assert.equal(await verifySignature(KEY, new TextEncoder().encode(body), await sign(body, KEY)), true);
  });

  it('rejects a wrong secret, malformed header, and tampered body', async () => {
    const body = JSON.stringify({ hello: 'world' });
    assert.equal(await verifySignature('other', new TextEncoder().encode(body), await sign(body, KEY)), false);
    assert.equal(await verifySignature(KEY, new TextEncoder().encode(body), 'sha1=abc'), false);
    assert.equal(
      await verifySignature(KEY, new TextEncoder().encode(body + 'x'), await sign(body, KEY)),
      false,
    );
  });
});

describe('fetch', () => {
  it('rejects requests with an invalid signature with 401', async () => {
    const body = JSON.stringify({ zen: 'keep it logically awesome' });
    const res = await worker.fetch(githubRequest(body, await sign(body, KEY_2)), env);
    assert.equal(res.status, 401);
  });

  it('rejects requests without a signature with 401', async () => {
    const res = await worker.fetch(githubRequest(JSON.stringify({ zen: 'x' }), null), env);
    assert.equal(res.status, 401);
  });

  it('rejects non-POST requests with 405', async () => {
    const res = await worker.fetch(new Request('https://worker.example.com/hooks/main', { method: 'PUT' }), env);
    assert.equal(res.status, 405);
  });

  it('returns 404 for an unknown route name', async () => {
    const body = JSON.stringify({ zen: 'x' });
    const res = await worker.fetch(githubRequest(body, await sign(body, KEY), '/hooks/nope'), env);
    assert.equal(res.status, 404);
  });

  it('returns 404 for requests without a route name', async () => {
    const body = JSON.stringify({ zen: 'x' });
    const res = await worker.fetch(githubRequest(body, await sign(body, KEY), '/'), env);
    assert.equal(res.status, 404);
  });

  it('forwards a signed event to the target named in the path', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    };
    try {
      const body = JSON.stringify({ ref: 'refs/heads/main' });
      const res = await worker.fetch(githubRequest(body, await sign(body, KEY_2), '/hooks/other'), env);
      assert.equal(res.status, 200);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://grok.example.com/hook-2');
      assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY_2}`);
      assert.equal(calls[0].init.headers['X-GitHub-Event'], 'push');
      assert.equal(calls[0].init.headers['X-GitHub-Delivery'], 'delivery-1');
      assert.deepEqual(new Uint8Array(calls[0].init.body), new TextEncoder().encode(body));

      const summary = await res.json();
      assert.equal(summary.name, 'other');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns 502 when the forward fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    try {
      const body = JSON.stringify({ zen: 'x' });
      const res = await worker.fetch(githubRequest(body, await sign(body, KEY)), env);
      assert.equal(res.status, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
