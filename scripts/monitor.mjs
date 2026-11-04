import environments from "../config/environments.json" with { type: "json" };
import { identity, client, basic, full } from "./probes.mjs";
const [environment, mode] = process.argv.slice(2),
  config = environments[environment];
if (!config || !["basic", "full"].includes(mode))
  throw new Error("Usage: monitor.mjs <production|staging> <basic|full>");
if (!config.launched) {
  console.log("Environment has not launched; no probes sent.");
  process.exit(0);
}
if (
  !process.env.STATUS_INGEST_TOKEN ||
  process.env.STATUS_INGEST_TOKEN.length < 32
)
  throw new Error("Missing observation credential");
const host = mode === "full" ? identity(process.env.MONITOR_SIGNING_KEY) : null;
if (host && host.serverId !== process.env.MONITOR_SERVER_ID)
  throw new Error("Synthetic identity is not configured");
const observedAt = Math.floor(Date.now() / 1000),
  runId = `${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}`;
async function write(path, value) {
  const response = await fetch(`https://status.topiaforge.dev${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.STATUS_INGEST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Status storage is unavailable");
  return response.json();
}
// A durable slot claim bounds manual dispatches and queued workflow runs, including failed runs.
const claim = await write("/internal/claim", { environment, mode });
if (!claim.acquired) {
  console.log("This monitoring slot was already claimed; no probes sent.");
  process.exit(0);
}
const api = client(config.origin),
  components =
    mode === "full" ? await full(api, config, host) : await basic(api, config);
let activity = null;
if (mode === "basic" && process.env.MONITOR_ACTIVITY_TOKEN) {
  try {
    const response = await api("GET", "/v1/monitor/activity", {
      token: process.env.MONITOR_ACTIVITY_TOKEN,
    });
    if (response.status === 200) activity = response.value;
  } catch {
    /* Missing activity remains a gap; reliability observations still persist. */
  }
}
await write("/internal/observations", {
  environment,
  observedAt,
  runId,
  components,
  activity,
});
console.log(
  `${environment}: ${components.map((c) => `${c.component}=${c.outcome}`).join(", ")}. Measurements stored.`,
);
