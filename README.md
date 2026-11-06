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
- A durable claim ties each run to one environment, mode and time slot. Full probes also hold a short lease so adjacent runs cannot use the same synthetic host at once. The runner retries transient storage errors with the same claim and the same measurements.
- A failed check degrades the component. Two failures in adjacent slots open an incident, and two adjacent successes recover it. Either result in the latest pair can arrive first.
- Missing or blocked checks are unknown. Freshness expires after three check intervals. Observed uptime excludes unknowns; coverage exposes their absence. Maintenance does not erase failed measurements.
- The current API preserves `measurementState` separately from maintenance. Missing evidence remains visible during maintenance, and the page shows when monitoring began for each service. Coverage starts with that first slot and counts the current slot once a measurement arrives or the slot ends.
- Response times measure the external probe's API and browser journey, not in-game latency. Median and p95 use successful detailed observations from at most 30 days. The 90-day view uses UTC calendar-day boundaries so archived daily counts cannot inflate a partial day.
- Activity includes public and invite-only Internet sessions across builds, excludes LAN sessions and configured synthetic identities, and uses host-reported player counts. These are estimates, not unique players.
- The control plane suppresses both counts below five active sessions or ten reported players, stores no exact suppressed counts, and waits fifteen minutes before releasing a snapshot. Only released aggregates enter this database. Stale or malformed optional activity never discards otherwise valid uptime observations.
- Detailed observations remain for 30 complete days, daily availability summaries and released activity for 90 days. Automatic resolved incidents remain for 90 days; unresolved incidents and committed notes remain visible.

## Commissioning

1. Merge the control-plane activity change to `dev`, review it, and deploy through its protected staging environment. Keep production multiplayer deployment separate.
2. Configure a dedicated `MONITOR_ACTIVITY_TOKEN` and `MONITOR_SERVER_IDS` on the staging Worker. The latter is the SHA-256 hash of the monitor's Ed25519 public signing key. A monitor keeps its signing identity stable; keys and tokens belong only in secret stores, never source, chat, logs or artifacts. Instrumentation remains inactive until both settings exist.
3. Create Cloudflare D1 database `topiaforge-status` and a protected GitHub environment `status-deploy`: required reviewer, no administrator bypass, custom branch policy limited to `main`. Configure `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `STATUS_DATABASE_ID` there through the secret forms.
4. Configure distinct status Worker secrets `INGEST_TOKEN_STAGING` and `INGEST_TOKEN_PRODUCTION` through Cloudflare's secret settings. Rotate staging's monitor off the former shared `INGEST_TOKEN`, then remove that secret. Create `status-monitor-staging` and `status-monitor-production` environments restricted to `main`, without interactive deployment approval. Give each its own `STATUS_INGEST_TOKEN` and `MONITOR_SIGNING_KEY` (Ed25519 PKCS8 PEM), plus the public `MONITOR_SERVER_ID` variable. Leave production `MONITOR_ACTIVITY_TOKEN` unset until the public-only activity migration and native disclosure pass. Monitoring secrets must have no deployment or administration permissions.
5. Dispatch **Deploy status page**, approve the protected deployment, and verify the custom-domain DNS/certificate, page and JSON endpoints. The custom Worker domain provisions the route on `topiaforge.dev`; `workers.dev`, preview URLs and invocation logs remain disabled.
6. Set repository variable `STATUS_MONITORING_ENABLED=true`, dispatch a basic and full probe, and read back their actual stored results. Confirm synthetic exclusion, at least fifteen minutes of publication delay, and the first released activity record before declaring commissioning complete. Never enable monitoring as a substitute for this validation.
7. Production monitoring may run while `launched` is false by setting `monitorEnabled` true in `config/environments.json`. Its stored prelaunch observations stay out of the public current and history APIs. Use a separate unprivileged runner account and five- and ten-minute timers, with only one writer per production check. After the control plane, relay, storage and scheduled checks pass, set `launched` true through review and deploy the page. Keep `stableClientPublished` false until a stable client is actually published; the page then says that internal tests and previews still use staging. Production activity remains unavailable until its privacy upgrade is commissioned.

Deployment checks fail if credentials or an existing protected environment are missing. Do not copy workstation OAuth credentials into GitHub. Provision secrets directly through their provider's secret forms; do not reveal them in command output.

## Incident explanations and maintenance

Edit `config/incidents.json` through a reviewed change. Each record has `id`, `environment`, `kind` (`note` or `maintenance`), `title`, `body`, `components`, `startsAt`, `endsAt`, and `incidentId`. Times are integer UTC Unix seconds; `endsAt` and `incidentId` can be null. Copy an automatic incident's public `id` to link an explanation. Only maintenance records alter the current status display; neither kind changes measurements. `npm run check` validates the file. Deploy the reviewed source to publish it.

## Public API

- `GET /api/status`: environments, component status, latest check times and released activity.
- `GET /api/history?environment=staging&range=24h`: `24h`, `7d`, `30d`, or `90d`; observed uptime, coverage, latency and released activity. Daily historical summaries replace expired detailed samples.
- `GET /api/incidents`: automatic incidents and committed explanations/maintenance.
- `/internal/run-claim` and `/internal/observations`: authenticated monitor writes. `/internal/claim` supports earlier runners during the rollout. All three reject unauthenticated access.

The page refreshes current checks and incidents every minute. It refreshes 24-hour history every five minutes and loads longer windows on selection. Successful history responses are briefly cached at the edge.

An external Linux runner schedules staging probes. The GitHub Actions workflow is available for manual checks from `main`. Deploy the Worker with its migrations through the protected workflow before updating the runner. Earlier runners can keep collecting during that deployment. Roll back the runner before rolling back the Worker.

When data is stale, compare the timer runs with the slot and result in the runner log and check for a storage acknowledgement. TURN reports fixed failure stages for credential issuance, DNS, allocation, permission, channel binding and payload delivery. A pass after a packet retry is stored as `relay-retried`. A local UDP socket setup failure leaves the result unknown. Verify both modes in public history after updating the runner.

A provider-wide Cloudflare outage can affect both this page and multiplayer.

## Author and player experience

Players can inspect availability without signing in, see exactly when evidence becomes stale, and compare environments. Counts preserve invite-only sessions' privacy without requiring game or launcher changes. Maintainers publish incident explanations through source review and reuse the existing protected deployment model.
