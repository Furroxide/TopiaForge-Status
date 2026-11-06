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
- Activity includes only public Internet sessions across builds. Invite-only sessions, LAN sessions and configured synthetic identities are excluded entirely. Host-reported public player estimates are not unique players.
- The control plane suppresses both bands below five public sessions or ten public players, rounds down before snapshot storage, and waits fifteen minutes after collection. Inclusive bands span five sessions and ten players. Only qualified `topiaforge.activity/2` public bands enter this database; exact combined legacy counts are rejected. Stale or malformed optional activity never discards otherwise valid uptime observations.
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
- `/internal/run-claim` and `/internal/observations`: authenticated monitor writes. `/internal/claim` supports earlier runners during the rollout. All three reject unauthenticated access.

The page refreshes current checks and incidents every minute. It refreshes 24-hour history every five minutes and loads longer windows on selection. Successful history responses are briefly cached at the edge.

An external Linux runner schedules staging probes. The GitHub Actions workflow is available for manual checks from `main`. Deploy the Worker with its migrations through the protected workflow before updating the runner. Earlier runners can keep collecting during that deployment. Roll back the runner before rolling back the Worker.

When data is stale, compare the timer runs with the slot and result in the runner log and check for a storage acknowledgement. TURN reports fixed failure stages for credential issuance, DNS, allocation, permission, channel binding and payload delivery. A pass after a packet retry is stored as `relay-retried`. A local UDP socket setup failure leaves the result unknown. Verify both modes in public history after updating the runner.

A provider-wide Cloudflare outage can affect both this page and multiplayer.

## Author and player experience

Players can inspect availability without signing in, see exactly when evidence becomes stale, and compare environments. Public activity bands exclude invite-only sessions. The launcher and CLI disclose this behavior before public hosting; the existing address and voice wording is unchanged. Maintainers publish incident explanations through source review and reuse the existing protected deployment model.

## Activity privacy upgrade

Apply migration `0003_public_activity.sql` before deploying the new Worker. It deletes unqualified combined history, prevents retired writers from refilling the legacy table, and creates separate public-only storage. The new Worker reads only that storage and uses a new history cache namespace; never copy or round legacy history into it. Current and history APIs return the activity schema, public scope and inclusive `sessionsBand`/`playersBand` objects (`min`, `max`), with null bands when withheld or unavailable. The browser validates this contract too, including mixed-version responses, and labels chart points as band lower bounds.

For commissioning, pause collection, apply the migration, deploy the Worker and assets, retire old Worker versions, and purge the old history cache before resuming probes. Deploy the version 2 producer and verify the disclosure in the CLI, launcher and native in-game Public HOST before production activity is enabled. Current coverage includes the CLI and launcher; the native HOST notice and presenter regression require separate integration and an on-screen wrap and visibility check. Keep production activity inactive until all three paths are covered. Verify legacy ingest remains a gap, old history is absent, and current/history responses contain only public bands after the fifteen-minute delay. A deployment may temporarily report unavailable activity; do not fall back to combined totals. Previously downloaded legacy data cannot be recalled. These source changes do not deploy or commission the service.
