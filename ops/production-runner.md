# Production status runner

The production monitor uses a dedicated non-login Unix user on the existing status Droplet. It has its own app
checkout, root-owned secret file and five- and ten-minute systemd timers. The staging runner remains on its
existing user, checkout, credentials and timers. The unit files in `systemd/` are the source of truth.

## Provisioning

1. Install the status repository at the exact deployed `main` revision under
   `/opt/topiaforge-status-monitor-production/app` and run `npm ci --ignore-scripts --no-audit --no-fund` with Node
   24.18.0. Keep the checkout root-owned and readable by the runner.
2. Create `topiaforge-monitor-prod` as a system user with `/usr/sbin/nologin` and no home directory.
3. Create `/etc/topiaforge-status-monitor-production` with mode `0700`. Store the production-only ingest token in
   `ingest-token` and the Ed25519 PKCS8 PEM in `signing-key`, each root-owned mode `0600`. Store only the public
   `MONITOR_SERVER_ID` in `public.env`, matching the signing public key's SHA-256 hash. The unit uses systemd
   `LoadCredential=` to give these secrets only to its service account at run time; do not put them in environment
   variables or unit arguments. Install the same ingest token in the status Worker's `INGEST_TOKEN_PRODUCTION`
   secret and the matching GitHub environment. Do not set `MONITOR_ACTIVITY_TOKEN` until the activity privacy and
   native disclosure gates pass; add it as a systemd credential when that later gate is approved.
4. Install the three unit files under `/etc/systemd/system`, then run `systemctl daemon-reload`. Keep both timers
   disabled until the production control plane and TURN service pass live checks.
5. Run `systemctl start topiaforge-status-monitor-production@basic.service` and then the `full.service` after the
   Worker is ready. Check each unit's `Result=success` and `ExecMainStatus=0`; inspect private stored observations
   in the status service. The full probe must exercise bidirectional UDP TURN and clean up its synthetic host.
6. Enable and start both timers. Confirm their next fire times and stored five- and ten-minute observations before
   changing `production.launched` to `true` through review. Only after that change can `/api/history` show public
   production history; then verify public history, freshness and missing-slot reporting. Keep
   `stableClientPublished` false until a stable client is actually released.

For the private prelaunch readback, use the maintainer's Cloudflare D1 dashboard SQL console for the production
`topiaforge-status` database. Do not give the runner D1 administration access. Run these read-only queries after
the manual probes and again after both timers have fired:

```sql
SELECT mode, slot, observed_at, run_id
FROM claim_owners WHERE environment = 'production'
ORDER BY observed_at DESC LIMIT 12;

SELECT component, slot, observed_at, outcome, reason
FROM observations WHERE environment = 'production'
ORDER BY observed_at DESC LIMIT 24;
```

Expect fresh `basic` slots every 300 seconds with an `api` observation, and fresh `full` slots every 600 seconds
with `discovery`, `invites`, `signaling` and `relay` observations. Each launch probe must pass; investigate a failed
or absent component before making Production public. Compare expected timer slots with `claim_owners` to identify
missed invocations. The public APIs deliberately hide these prelaunch records until `launched` becomes true.

The production unit uses the existing root-owned Node runtime but does not share the staging process identity,
checkout or credential files. The production timer offsets stagger the staging timer starts on this Droplet. A
failed or missing run remains visible as a missing slot; do not treat a successful timer start as a passed probe.
