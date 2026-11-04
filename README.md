# TopiaForge Status

Public multiplayer availability and privacy-preserving activity estimates at **https://status.topiaforge.dev**.
The page and measurement store deploy separately from the game and multiplayer control plane.

## Development

Use Node.js 24.18.0. Run `npm ci --ignore-scripts`, `npm test`, `npm run check`, then `npm run dev`.
Apply local migrations first with `npx --no-install wrangler d1 migrations apply DB --local`.
The production database identifier is injected at deployment and never committed.

Production starts as **Not yet launched**. Staging starts **Unknown**, with empty history until real observations arrive.
No uptime history or sample player activity is seeded. The page uses TopiaForge's existing wordmark and favicon.

## Data and meaning

- Basic API/browser probes run every five minutes; hosting, invites, signaling and real UDP TURN probes every ten.
- One durable claim per environment, mode and time slot bounds queued or manually dispatched checks.
- A failed check degrades the component. Two failures in adjacent slots open an incident; two adjacent successes recover it.
- Missing or blocked checks are unknown. Freshness expires after three check intervals. Observed uptime excludes unknowns; coverage exposes their absence. Maintenance does not erase failed measurements.
- The current API preserves `measurementState` separately from maintenance. Missing evidence remains visible during maintenance, and the page shows when monitoring began for each service. Coverage counts expected checks only from that start within the selected window; earlier time remains unobserved.
- Response times measure the external probe's API and browser journey, not in-game latency. Median and p95 use successful detailed observations from at most 30 days. The 90-day view uses UTC calendar-day boundaries so archived daily counts cannot inflate a partial day.
- Activity includes public and invite-only Internet sessions across builds, excludes LAN sessions and configured synthetic identities, and uses host-reported player counts. These are estimates, not unique players.
- The control plane suppresses both counts below five active sessions or ten reported players, stores no exact suppressed counts, and waits fifteen minutes before releasing a snapshot. Only released aggregates enter this database. Stale or malformed optional activity never discards otherwise valid uptime observations.
- Detailed observations remain for 30 complete days, daily availability summaries and released activity for 90 days. Automatic resolved incidents remain for 90 days; unresolved incidents and committed notes remain visible.

## Commissioning

1. Merge the control-plane activity change to `dev`, review it, and deploy through its protected staging environment. Keep production multiplayer deployment separate.
2. Configure a dedicated `MONITOR_ACTIVITY_TOKEN` and `MONITOR_SERVER_IDS` on the staging Worker. The latter is the SHA-256 hash of the monitor's Ed25519 public signing key. A monitor keeps its signing identity stable; keys and tokens belong only in secret stores, never source, chat, logs or artifacts. Instrumentation remains inactive until both settings exist.
3. Create Cloudflare D1 database `topiaforge-status` and a protected GitHub environment `status-deploy`: required reviewer, no administrator bypass, custom branch policy limited to `main`. Configure `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `STATUS_DATABASE_ID` there through the secret forms.
4. Configure the status Worker's separate `INGEST_TOKEN` through Cloudflare's secret settings. Create `status-monitor-staging` and `status-monitor-production` environments restricted to `main`, without interactive deployment approval. Add `STATUS_INGEST_TOKEN`, `MONITOR_SIGNING_KEY` (Ed25519 PKCS8 PEM) and `MONITOR_ACTIVITY_TOKEN` secrets, plus the public `MONITOR_SERVER_ID` variable. Monitoring secrets must have no deployment or administration permissions.
5. Dispatch **Deploy status page**, approve the protected deployment, and verify the custom-domain DNS/certificate, page and JSON endpoints. The custom Worker domain provisions the route on `topiaforge.dev`; `workers.dev`, preview URLs and invocation logs remain disabled.
6. Set repository variable `STATUS_MONITORING_ENABLED=true`, dispatch a basic and full probe, and read back their actual stored results. Confirm synthetic exclusion, at least fifteen minutes of publication delay, and the first released activity record before declaring commissioning complete. Never enable monitoring as a substitute for this validation.
7. Production remains disabled until production multiplayer is verified. Configure its independent monitor settings, update `config/environments.json` through review, deploy the page, then run the same commissioning checks. Do not change the repository's default branch to bypass a game release gate.

Deployment checks fail if credentials or an existing protected environment are missing. Do not copy workstation OAuth credentials into GitHub. Provision secrets directly through their provider's secret forms; do not reveal them in command output.

## Incident explanations and maintenance

Edit `config/incidents.json` through a reviewed change. Each record has `id`, `environment`, `kind` (`note` or `maintenance`), `title`, `body`, `components`, `startsAt`, `endsAt`, and `incidentId`. Times are integer UTC Unix seconds; `endsAt` and `incidentId` can be null. Copy an automatic incident's public `id` to link an explanation. Only maintenance records alter the current status display; neither kind changes measurements. `npm run check` validates the file. Deploy the reviewed source to publish it.

## Public API

- `GET /api/status`: environments, component status, latest check times and released activity.
- `GET /api/history?environment=staging&range=24h`: `24h`, `7d`, `30d`, or `90d`; observed uptime, coverage, latency and released activity. Daily historical summaries replace expired detailed samples.
- `GET /api/incidents`: automatic incidents and committed explanations/maintenance.
- `/internal/claim` and `/internal/observations`: authenticated monitor-only writes, never callable by page visitors. Unauthenticated access is always 401.

GitHub schedules can be delayed, dropped, or automatically disabled after repository inactivity. Check the Actions schedule when data is stale; do not fill missing time with successes or create keep-alive source commits. This status service shares Cloudflare infrastructure with multiplayer; a provider-wide outage can affect both.

## Author and player experience

Players can inspect availability without signing in, see exactly when evidence becomes stale, and compare environments. Counts preserve invite-only sessions' privacy without requiring game or launcher changes. Maintainers publish incident explanations through source review and reuse the existing protected deployment model.
