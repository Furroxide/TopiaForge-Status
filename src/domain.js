export const COMPONENTS = Object.freeze({
  api: { label: "Control plane API", cadence: 300 },
  discovery: { label: "Discovery and hosting", cadence: 600 },
  invites: { label: "Invites", cadence: 600 },
  signaling: { label: "Signaling", cadence: 600 },
  relay: { label: "TURN relay", cadence: 600 },
});
export const MONITOR_MODES = Object.freeze({
  basic: { cadence: COMPONENTS.api.cadence, components: ["api"] },
  full: {
    cadence: COMPONENTS.discovery.cadence,
    components: ["discovery", "invites", "signaling", "relay"],
  },
});
export const slotAt = (at, cadence) => Math.floor(at / cadence) * cadence;
export const validRunId = (id) =>
  typeof id === "string" && /^[0-9]{1,24}(?:-[0-9]{1,4})?$/.test(id);
export const validObservationTime = (at, now, age) =>
  Number.isSafeInteger(at) && at > 0 && at <= now + 30 && at >= now - age;
export const monitoringEnabled = (config) => config.monitorEnabled ?? config.launched;
export const RANGES = Object.freeze({
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
  "90d": 7776000,
});
export const REASONS = Object.freeze([
  "ok",
  "disabled",
  "timeout",
  "invalid-response",
  "http-error",
  "dependency",
  "probe-error",
  "rate-limited",
  "runner-error",
  "host-cleanup",
  "relay-credentials",
  "relay-dns",
  "relay-allocation",
  "relay-permission",
  "relay-channel",
  "relay-payload",
  "relay-retried",
]);
export function consecutive(a, b, cadence) {
  return !!a && !!b && a.slot - b.slot === cadence;
}
export function componentState(rows, now, cadence, launched) {
  if (!launched) return "not-yet-launched";
  const [last, previous] = rows;
  if (
    !last ||
    now - last.observed_at >= cadence * 3 ||
    last.outcome === "blocked"
  )
    return "unknown";
  if (last.outcome === "fail")
    return consecutive(last, previous, cadence) && previous.outcome === "fail"
      ? "outage"
      : "degraded";
  // An open incident remains recovering until two adjacent successful slots.
  if (previous?.outcome === "fail" && consecutive(last, previous, cadence))
    return "degraded";
  return "operational";
}
export function summary(
  rows,
  daily,
  now,
  firstSlot,
  cadence,
  latencySince = -Infinity,
) {
  const passed =
    rows.filter((r) => r.outcome === "pass").length +
    daily.reduce((n, r) => n + r.passed, 0);
  const failed =
    rows.filter((r) => r.outcome === "fail").length +
    daily.reduce((n, r) => n + r.failed, 0);
  // The current slot isn't a gap while there is still time for a check to run.
  const currentSlot = slotAt(now, cadence);
  const lastSlot =
    rows.at(-1)?.slot === currentSlot ? currentSlot : currentSlot - cadence;
  const expected =
    firstSlot == null ? 0 : Math.max(0, (lastSlot - firstSlot) / cadence + 1);
  const latencies = rows
    .filter(
      (r) =>
        r.outcome === "pass" &&
        r.observed_at >= latencySince &&
        Number.isFinite(r.latency_ms),
    )
    .map((r) => r.latency_ms)
    .sort((a, b) => a - b);
  const percentile = (p) =>
    latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
  return {
    passed,
    failed,
    expected,
    uptime: passed + failed ? (100 * passed) / (passed + failed) : null,
    coverage: expected
      ? Math.min(100, (100 * (passed + failed)) / expected)
      : null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    latencySamples: latencies.length,
  };
}
export function validateActivity(value, now) {
  if (
    !value ||
    value.schema !== "topiaforge.activity/1" ||
    !Number.isSafeInteger(value.sampledAt) ||
    value.sampledAt % 300 ||
    value.sampledAt > now - 900 ||
    value.sampledAt < now - 86400
  )
    throw new Error("invalid activity");
  if (!["available", "suppressed", "unavailable"].includes(value.state))
    throw new Error("invalid activity");
  if (value.state === "available") {
    if (
      !Number.isSafeInteger(value.sessions) ||
      value.sessions < 5 ||
      value.sessions > 1e7 ||
      !Number.isSafeInteger(value.players) ||
      value.players < 10 ||
      value.players > 1e9
    )
      throw new Error("invalid activity");
  } else if (value.sessions !== null || value.players !== null)
    throw new Error("invalid activity");
  // Reconstruct instead of retaining arbitrary fields from an authenticated caller.
  return {
    sampledAt: value.sampledAt,
    state: value.state,
    sessions: value.sessions,
    players: value.players,
  };
}
export function validateObservation(value, now, environments) {
  if (
    !value ||
    typeof value.environment !== "string" ||
    !Object.hasOwn(environments, value.environment) ||
    !monitoringEnabled(environments[value.environment]) ||
    !validRunId(value.runId) ||
    !validObservationTime(value.observedAt, now, 3600) ||
    !Array.isArray(value.components) ||
    value.components.length > 5 ||
    !value.components.length
  )
    throw new Error("invalid observation");
  const seen = new Set();
  const components = value.components.map((r) => {
    if (
      typeof r?.component !== "string" ||
      !Object.hasOwn(COMPONENTS, r.component) ||
      seen.has(r.component) ||
      !["pass", "fail", "blocked"].includes(r.outcome) ||
      !REASONS.includes(r.reason) ||
      (r.latencyMs !== null &&
        (!Number.isFinite(r.latencyMs) ||
          r.latencyMs < 0 ||
          r.latencyMs > 120000))
    )
      throw new Error("invalid observation");
    seen.add(r.component);
    return {
      component: r.component,
      outcome: r.outcome,
      reason: r.reason,
      latencyMs: r.latencyMs,
    };
  });
  const { mode, slot } = value;
  if (mode !== undefined || slot !== undefined) {
    if (typeof mode !== "string" || !Object.hasOwn(MONITOR_MODES, mode))
      throw new Error("invalid monitoring mode");
    const expected = MONITOR_MODES[mode];
    if (
      slot !== slotAt(value.observedAt, expected.cadence) ||
      components.length !== expected.components.length ||
      expected.components.some((component) => !seen.has(component))
    )
      throw new Error("observation does not match its slot or mode");
  }
  let activity = null;
  try {
    if (value.activity != null)
      activity = validateActivity(value.activity, now);
  } catch {
    /* Optional telemetry never discards a valid availability check. */
  }
  return {
    environment: value.environment,
    runId: value.runId,
    observedAt: value.observedAt,
    mode,
    slot,
    components,
    activity,
  };
}
export function validateNotes(notes, environments) {
  if (!Array.isArray(notes)) throw new Error("notes must be an array");
  const ids = new Set();
  for (const n of notes) {
    if (
      !/^[a-z0-9-]{1,100}$/.test(n.id) ||
      ids.has(n.id) ||
      !Object.hasOwn(environments, n.environment) ||
      !["note", "maintenance"].includes(n.kind) ||
      typeof n.title !== "string" ||
      !n.title.trim() ||
      n.title.length > 160 ||
      typeof n.body !== "string" ||
      n.body.length > 4000 ||
      !Array.isArray(n.components) ||
      !n.components.length ||
      n.components.some((c) => !Object.hasOwn(COMPONENTS, c)) ||
      !Number.isSafeInteger(n.startsAt) ||
      (n.endsAt !== null &&
        (!Number.isSafeInteger(n.endsAt) || n.endsAt <= n.startsAt)) ||
      (n.incidentId !== null &&
        !/^(production|staging)-(api|discovery|invites|signaling|relay)-[0-9]+$/.test(
          n.incidentId,
        ))
    )
      throw new Error("invalid incident note");
    ids.add(n.id);
  }
  return notes;
}
