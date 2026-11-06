import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import environments from "../config/environments.json" with { type: "json" };
import { identity, client, basic, full } from "./probes.mjs";
import { MONITOR_MODES, slotAt, validateActivity } from "../src/domain.js";

class MonitorError extends Error {}

export async function writeStatus(
  path,
  value,
  token,
  { fetchImpl = fetch, wait = sleep } = {},
) {
  const body = JSON.stringify(value);
  for (const delay of [0, 500, 1500]) {
    if (delay) await wait(delay);
    let response;
    try {
      response = await fetchImpl(`https://status.topiaforge.dev${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (response.ok) return await response.json();
    } catch {
      // A lost response may follow a successful commit. Replay the same bytes.
      continue;
    }
    await response.body?.cancel().catch(() => {});
    if (response.status < 500 && ![408, 429].includes(response.status))
      throw new MonitorError(
        `Status storage rejected the request (HTTP ${response.status}).`,
      );
  }
  throw new MonitorError("Status storage is unavailable after three attempts.");
}

async function main() {
  const [environment, mode] = process.argv.slice(2);
  if (
    !Object.hasOwn(environments, environment) ||
    !Object.hasOwn(MONITOR_MODES, mode)
  )
    throw new MonitorError(
      "Usage: monitor.mjs <production|staging> <basic|full>",
    );
  const config = environments[environment];
  if (!config.launched) {
    console.log("Environment has not launched; no probes sent.");
    return;
  }
  const ingestToken = process.env.STATUS_INGEST_TOKEN;
  if (!ingestToken || ingestToken.length < 32)
    throw new MonitorError("Missing observation credential.");
  const host =
    mode === "full" ? identity(process.env.MONITOR_SIGNING_KEY) : null;
  if (host && host.serverId !== process.env.MONITOR_SERVER_ID)
    throw new MonitorError("Synthetic identity is not configured.");

  const observedAt = Math.floor(Date.now() / 1000);
  const localId = () =>
    `${Date.now()}${String(randomInt(1e10)).padStart(10, "0")}`;
  const runId = `${process.env.GITHUB_RUN_ID ?? localId()}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`;
  const run = { environment, mode, observedAt, runId };
  const claim = await writeStatus("/internal/run-claim", run, ingestToken);
  if (
    typeof claim?.acquired !== "boolean" ||
    claim.slot !== slotAt(observedAt, MONITOR_MODES[mode].cadence)
  )
    throw new MonitorError("Status storage returned an invalid run claim.");
  if (!claim.acquired) {
    console.log(
      `${environment} ${mode} slot ${claim.slot}: another run owns this slot or is still active.`,
    );
    return;
  }

  const api = client(config.origin);
  const components =
    mode === "full" ? await full(api, config, host) : await basic(api, config);
  let activity = null;
  if (mode === "basic" && process.env.MONITOR_ACTIVITY_TOKEN) {
    try {
      const response = await api("GET", "/v1/monitor/activity", {
        token: process.env.MONITOR_ACTIVITY_TOKEN,
      });
      if (response.status === 200)
        activity = {
          schema: "topiaforge.activity/2",
          ...validateActivity(response.value, Math.floor(Date.now() / 1000)),
        };
    } catch {
      /* Missing activity remains a gap; reliability observations still persist. */
    }
  }
  const results = components
    .map((c) => `${c.component}=${c.outcome} (${c.reason})`)
    .join(", ");
  console.log(`${environment} ${mode} slot ${claim.slot}: ${results}.`);
  const saved = await writeStatus(
    "/internal/observations",
    {
      ...run,
      slot: claim.slot,
      components,
      activity,
    },
    ingestToken,
  );
  if (saved?.accepted !== true)
    throw new MonitorError("Status storage did not confirm the measurements.");
  console.log("Measurements stored.");
}

if (import.meta.main) {
  const deadline = setTimeout(() => {
    console.error("Monitoring run exceeded its time limit.");
    process.exit(1);
  }, 180000).unref();
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof MonitorError ? error.message : "Monitoring run failed.",
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}
