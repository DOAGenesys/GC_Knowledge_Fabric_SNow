# Knowledge Sync for ServiceNow

Keeps Genesys Cloud Knowledge in step with your ServiceNow knowledge bases. It works with Customer Service Management (CSM) and IT Service Management (ITSM) knowledge alike: every sync copies the published articles of one or more knowledge bases into a Genesys Cloud **File Upload** knowledge source, then keeps it current on a schedule or on demand.

- **Sign in with Genesys Cloud.** No separate accounts.
- **Connect ServiceNow** with basic auth, OAuth client credentials or an API key. The connection is tested before it's saved.
- **Create a sync in four steps:** pick knowledge bases (optionally narrowed with an encoded query, with a live preview), choose or create a knowledge source, decide where article links should point (CSM portal, Employee Center, …) and set a schedule.
- **Schedules:** every few minutes or hours, daily, on chosen weekdays (in your time zone), or manual only.
- **Sync now** checks for changes and uploads only what changed. **Full rebuild** replaces the whole source.
- **Errors are explained in plain language**, each with a fix-it link. You also see per-article status and a history of every run.

## How it works

| Piece | What it does |
| --- | --- |
| Sign-in | Genesys Cloud OAuth (Code Authorization with PKCE), used only to identify you and your organization. |
| Sync credentials | One OAuth **Client Credentials** client per organization, encrypted at rest. Every Knowledge call uses it, scheduled or manual, so syncs run without anyone signed in. |
| Scheduler | A Vercel Schedule calls `/api/cron/tick` every 15 minutes. The tick finds due syncs, runs a quick change check against ServiceNow and starts a run only when something changed. |
| Runs | Durable [Vercel Workflow](https://vercel.com/docs/workflow) runs. Each run lists articles, compares them with what was uploaded last time, opens a Genesys Cloud synchronization, uploads changed files in batches, deletes removed ones, commits and waits for the outcome. Runs survive restarts and can be cancelled. |
| Storage | Neon Postgres (connections, syncs, runs, per-article manifest). The schema is created automatically. |

### Safety rails

- **Mass-deletion guard.** If ServiceNow suddenly returns no articles for a sync that has files in Genesys Cloud, the run stops with "ServiceNow returned no articles" and nothing is deleted. That is usually an account that lost read access.
- **Full rebuilds are all-or-nothing.** If any article can't be uploaded, the round is cancelled and the source stays as it was.
- **Retries:** rate limits and transient failures (HTTP 429/5xx, timeouts) are retried with backoff. Failing syncs back off before the next attempt.
- **Housekeeping:** stale runs are recovered and rounds left open by crashed runs are cleaned up.
- **Limits:** each sync is capped at 20,000 articles. Only published, active and unexpired articles are synced.

## Setup

### 1. Genesys Cloud: two OAuth clients

| Client | Grant type | Configuration |
| --- | --- | --- |
| **Sign-in** | Code Authorization (PKCE) | Redirect URI `https://<your-app-host>/api/auth/callback` (add `http://localhost:3000/api/auth/callback` for local development). Scopes: `users:readonly`, `organization:readonly`. |
| **Syncs** | Client Credentials | A role with `knowledge:source:view`, `knowledge:source:add` (to create sources from the app), `knowledge:synchronization:add`, `knowledge:synchronization:view`, `knowledge:synchronization:edit`, `knowledge:synchronization:upload`, `knowledge:synchronization:deleteFile` and, optionally, `knowledge:sourceFileCount:view` (shows file counts). |

Sign in with the first client, then enter the second one under **Connections → Genesys Cloud**. The app verifies that it belongs to the organization you signed in with. The Connections page can copy the permission list for you.

### 2. ServiceNow

The ServiceNow account needs:

- The `knowledge` role, or any role that can read `kb_knowledge_base` and `kb_knowledge`.
- `snc_platform_rest_api_access`, only when your instance enforces REST API access policies.
- Permission to read every knowledge base you sync (each knowledge base's "Can read" user criteria).
- Optionally, the Knowledge Management REST API plugin (`sn_km_api`), so template-based articles sync with their full body.

Authentication options:

- **Basic:** username and password of an integration user.
- **OAuth client credentials** (Washington DC and later):
  1. Set the system property `glide.oauth.inbound.client.credential.grant_type.enabled` to `true`.
  2. Create an OAuth API endpoint for external clients.
  3. Set its **OAuth Application User** to the integration user.
- **API key** (Washington DC and later): a REST API key with an inbound authentication profile. The app sends it in the `x-sn-apikey` header.

Article links point to the portal your agents and customers use. Portal links have the form `https://<instance>/<portal>?id=kb_article_view&sysparm_article=KB0010001`:

| Option | Portal |
| --- | --- |
| `csm` | Customer Service Portal (CSM) |
| `csp` | Consumer Service Portal |
| `esc` | Employee Center (ITSM) |
| `sp` | Service Portal |
| `custom` | Any other portal suffix |
| `classic` | Classic UI: `https://<instance>/kb_view.do?sysparm_article=KB0010001` |

The wizard suggests one based on the portals each knowledge base is published to.

### 3. Deploy on Vercel

1. Import the repository into a Vercel project (framework: Next.js). Functions run in Frankfurt (`fra1`, set in `vercel.json`). Change it if your users and Genesys Cloud org are elsewhere.
2. Add **Neon Postgres** from the Vercel Marketplace, in the same region as the functions. It sets `DATABASE_URL`.
3. Add `APP_SESSION_SECRET`, `APP_ENCRYPTION_KEY` and `CRON_SECRET` as **sensitive** environment variables. Each should be a random string of at least 32 characters, for example from `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`, piped straight into `vercel env add`. Never commit them.
4. Deploy, then open `https://<your-app-host>/api/health`. It returns `"status": "ok"` when the configuration is complete and the database answers (HTTP 503 and `"degraded"` otherwise).
5. Create the Genesys Cloud sign-in client with the deployment's redirect URI and sign in.

Changing `APP_ENCRYPTION_KEY` makes saved credentials unreadable. The app then asks you to enter them again.

**Plan limits.** On Hobby, a schedule can run at most every 15 minutes, and Vercel adds up to 15 minutes of jitter. A sync due at 07:30 therefore starts within about 15 to 30 minutes. Hobby also allows 5,000 schedule runs per billing period, and this app uses about 2,900. On Pro the jitter drops to one minute, and you can tighten `*/15` in `vercel.json` (for example to `*/5`).

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon Postgres connection string (set by the Neon integration). |
| `APP_SESSION_SECRET` | yes | Signs session cookies (32+ characters). |
| `APP_ENCRYPTION_KEY` | yes | Encrypts saved credentials with AES-256-GCM (32+ characters). |
| `CRON_SECRET` | yes | Vercel sends it as `Authorization: Bearer …` on scheduled calls (16+ characters). |
| `APP_ALLOWED_ORG_IDS` | no | Comma-separated Genesys Cloud organization IDs allowed to sign in. Empty means any organization. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error` or `silent`. Defaults to `info` in production and `debug` in development. |
| `LOG_FORMAT` | no | `json` (default on Vercel) or `pretty` (default locally). |
| `NEXT_PUBLIC_DEFAULT_GENESYS_REGION` | no | Region preselected on the sign-in page, such as `mypurecloud.de`. |
| `NEXT_PUBLIC_DEFAULT_GENESYS_CLIENT_ID` | no | Sign-in client ID prefilled on the sign-in page. Public, not a secret. |

See [`.env.example`](.env.example) for a template.

## Logging and debugging

**Vercel logs (server):**

- One structured JSON line per event, with a `requestId` (also returned as the `x-request-id` response header), the operation name, the duration and the error code.
- Credentials, tokens and article bodies are never logged.
- Reads log at `debug`. Changes, rejected requests and run summaries log at `info`, failures at `warn` or `error`, so production logs stay readable.
- Every scheduler tick that does work logs a summary. Idle ticks stay quiet apart from an hourly "Scheduler is running, nothing due" heartbeat, so you can confirm the schedule fires.

**Browser console:**

- In production, only warnings and errors appear.
- To see everything, run `kfDebug()` in the console or turn on **Verbose logging** in the user menu. Your API requests then carry `x-kf-debug: 1`, which raises the server log level to `debug` for those requests only. Turn it off with `kfDebug(false)`.
- Browser errors are batched, deduplicated and forwarded to `/api/client-log`, so they also show up in the Vercel logs.

## Development

```bash
npm install
cp .env.example .env.local   # fill in your own values; never commit this file
npm run dev
```

| Command | What it runs |
| --- | --- |
| `npm test` | Unit, flow and UI tests against in-memory Postgres (PGlite) and faithful fakes of the ServiceNow and Genesys Cloud APIs. |
| `npm run test:coverage` | The same, with coverage thresholds. |
| `npm run verify` | Type check, tests with coverage and a production build. |
| `npm run test:live` | The opt-in smoke test against real systems (below). |

### Live smoke test

`npm run test:live` runs against a real ServiceNow instance and a Genesys Cloud test org:

1. It syncs up to five published articles into a dedicated File Upload source.
2. It checks that the next change check finds nothing to do.
3. It narrows the sync and checks that the removed article is deleted.

The output is pass/fail per step. Failures show only an error code.

Provide the credentials as environment variables through a secret manager, for example `op run --env-file=live.env.tpl -- npm run test:live` with 1Password references in the template. Never put them on the command line.

| Name | Notes |
| --- | --- |
| `LIVE_SN_INSTANCE` | Instance name or URL. |
| `LIVE_SN_AUTH_TYPE` | `basic` (default), `oauth` or `apikey`. |
| `LIVE_SN_USERNAME`, `LIVE_SN_PASSWORD` | For `basic`. |
| `LIVE_SN_CLIENT_ID`, `LIVE_SN_CLIENT_SECRET` | For `oauth`. |
| `LIVE_SN_API_KEY` | For `apikey`. |
| `LIVE_SN_KB_ID` | Optional knowledge base `sys_id`. Defaults to the first readable knowledge base with articles. |
| `LIVE_SN_ARTICLES` | Optional number of articles, 1 to 5 (default 3). |
| `LIVE_GC_REGION` | For example `mypurecloud.ie`. |
| `LIVE_GC_CLIENT_ID`, `LIVE_GC_CLIENT_SECRET` | A Client Credentials client with the sync permissions above. |
| `LIVE_GC_SOURCE_NAME` | Optional. Defaults to `Knowledge Sync live test`. The source is created when missing and **fully replaced on every run**, so never point it at a real source. |
