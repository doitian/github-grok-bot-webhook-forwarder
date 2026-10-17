# github-grok-bot-webhook-forwarder

A Cloudflare Worker that receives GitHub webhook events, validates the
`X-Hub-Signature-256` HMAC signature, and forwards the event to one or more
Grok Bot routine webhooks.

## How it works

1. GitHub sends a `POST` with the event payload to `/hooks/<name>` on the worker.
2. The worker looks up `<name>` in the `GROK_WEBHOOKS` map (unknown names get a
   `404`) and verifies the request against `GITHUB_WEBHOOK_SECRET`
   (HMAC-SHA-256, constant-time comparison). Invalid signatures get a `401`.
3. The event is forwarded verbatim to the matching Grok Bot webhook —
   the exact body GitHub sent, plus its `Content-Type`, `X-GitHub-Event`, and
   `X-GitHub-Delivery` headers:

   ```
   POST <grok webhook url>
   Authorization: Bearer <grok webhook key>
   Content-Type: application/json
   X-GitHub-Event: push
   X-GitHub-Delivery: <delivery id>

   <original GitHub payload>
   ```

4. The worker responds `200` when the Grok webhook accepted the call
   (Grok Bot returns `200` when it starts a run), `502` if it failed — so
   failures are visible in GitHub's "Recent Deliveries" for redelivery.

## Setup

### 1. Deploy the worker

```powershell
npm install
npx wrangler login
npm run deploy
```

### 2. Configure secrets

```powershell
# The secret you will also enter on the GitHub webhook:
npx wrangler secret put GITHUB_WEBHOOK_SECRET

# A JSON object mapping route names to Grok Bot webhook targets.
# Find "POST to" (url) and "key" in each routine's Webhook section in Cursor.
npx wrangler secret put GROK_WEBHOOKS
# e.g. paste:
# {"infra-alerts":{"url":"https://...routine 1...","key":"key-1"},
#  "pr-reviews":{"url":"https://...routine 2...","key":"key-2"}}
```

Each route name becomes an endpoint: `POST /hooks/<name>` forwards to that
entry. Names may contain letters, digits, `-`, and `_`.

Cloudflare limits each secret value to **5 KB** (and 64 variables per Worker on
the free plan, 128 on paid). A target entry is ~120 bytes, so a single
`GROK_WEBHOOKS` secret holds roughly 40 routes; if you ever outgrow that, move
the map to Workers KV instead of a secret.

### 3. Create the GitHub webhook

Repository (or organization) → **Settings → Webhooks → Add webhook**:

- **Payload URL**: `https://github-grok-bot-webhook-forwarder.<your-subdomain>.workers.dev/hooks/<name>`
  (one webhook per route name you want to use; different repos can point at different names)
- **Content type**: `application/json`
- **Secret**: the value of `GITHUB_WEBHOOK_SECRET`
- **Events**: whatever you want forwarded (push, pull_request, issues, …)

GitHub's initial `ping` event is forwarded like any other event.

## Local development

```powershell
npm install
npm test          # unit tests (signature validation + forwarding)
npm run dev       # wrangler dev; copy .dev.vars.example to .dev.vars first
```

## Files

| File              | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `src/index.js`    | Worker: signature validation + fan-out forward |
| `wrangler.toml`   | Worker configuration                           |
| `test/index.test.js` | Tests run with `node --test`                |
