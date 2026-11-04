import { availabilityBuckets } from "./history-chart.js";
const $ = (s) => document.querySelector(s);
let environment = "production",
  generation = 0;
let renderedEnvironment = null,
  renderedRange = null;
const labels = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  maintenance: "Maintenance",
  unknown: "Unknown",
  "not-yet-launched": "Not yet launched",
};
const date = (seconds) =>
  seconds == null
    ? "No observations yet"
    : new Date(seconds * 1000).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
const number = (n) => (n == null ? "—" : new Intl.NumberFormat().format(n));
function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function time(at) {
  const e = el("time", date(at));
  if (at != null) e.dateTime = new Date(at * 1000).toISOString();
  return e;
}
async function get(path) {
  const r = await fetch(path, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("unavailable");
  return r.json();
}
function table(headers, rows) {
  const details = el("details"),
    summary = el("summary", "View measurements as a table"),
    wrap = el("div", null, "table-scroll"),
    t = el("table"),
    head = el("tr");
  for (const h of headers) head.append(el("th", h));
  t.append(head);
  if (rows.length > 288)
    details.append(
      el(
        "p",
        `Showing the latest 288 of ${number(rows.length)} measurements. The chart covers the full selected window.`,
        "caption",
      ),
    );
  for (const r of rows.slice(-288)) {
    const tr = el("tr");
    for (const c of r) tr.append(el("td", c));
    t.append(tr);
  }
  wrap.tabIndex = 0;
  wrap.append(t);
  details.append(summary, wrap);
  return details;
}
function availability(history, config) {
  const root = $("#availability");
  root.replaceChildren();
  for (const c of config.components) {
    const h = history.components[c.id],
      row = el("div", null, "history-row"),
      bars = el("div", null, "bars");
    for (const bucket of availabilityBuckets(history, h, c.cadence)) {
      const bar = el("span", null, `bar ${bucket.state}`);
      bar.title = `${date(bucket.from)}: ${bucket.passed} passed, ${bucket.failed} failed, ${bucket.expected} expected; unobserved time is unknown`;
      bars.append(bar);
    }
    bars.setAttribute("aria-hidden", "true");
    const numbers = el(
      "div",
      `${h.uptime == null ? "—" : h.uptime.toFixed(2) + "%"} uptime · ${h.coverage == null ? "—" : h.coverage.toFixed(1) + "%"} coverage`,
      "numbers",
    );
    if (h.startedAt != null && h.startedAt > history.from)
      numbers.append(
        el("span", `Monitoring since ${date(h.startedAt)}`, "monitoring-start"),
      );
    row.append(el("span", c.label), bars, numbers);
    root.append(row);
  }
  root.append(
    table(
      [
        "Service",
        "Passed",
        "Failed",
        "Expected",
        "Coverage",
        "Monitoring began",
      ],
      config.components.map((c) => {
        const h = history.components[c.id];
        return [
          c.label,
          number(h.passed),
          number(h.failed),
          number(h.expected),
          h.coverage == null ? "Unknown" : h.coverage.toFixed(1) + "%",
          date(h.startedAt),
        ];
      }),
    ),
  );
}
function activity(history) {
  const root = $("#activity-history");
  root.replaceChildren();
  const rows = history.activity;
  if (!rows.length) {
    root.append(el("p", "No released activity measurements yet.", "empty"));
    return;
  }
  const published = rows.filter((r) => r.state === "available");
  if (published.length) {
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 1000 150");
    svg.classList.add("chart");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      "Host-reported players over time. Suppressed or missing measurements break the line; exact values are in the table below.",
    );
    const max = Math.max(1, ...published.map((r) => r.players));
    let path = "";
    let previous = null;
    for (const row of rows) {
      if (row.state !== "available") {
        previous = null;
        continue;
      }
      const x =
          10 +
          (980 * (row.sampledAt - history.from)) / (history.to - history.from),
        y = 135 - (120 * row.players) / max;
      path += `${previous && row.sampledAt - previous.sampledAt === 300 ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)} `;
      previous = row;
    }
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    svg.append(p);
    root.append(svg);
  } else
    root.append(
      el(
        "p",
        "Activity is below the publication threshold, or telemetry is unavailable.",
        "empty",
      ),
    );
  root.append(
    table(
      ["Sample time", "Active sessions", "Reported players", "Publication"],
      rows.map((r) => [
        date(r.sampledAt),
        number(r.sessions),
        number(r.players),
        r.state === "suppressed" ? "Low activity" : r.state,
      ]),
    ),
  );
}
function renderIncidents(data) {
  const root = $("#incidents");
  root.replaceChildren();
  const notes = data.notes.filter((n) => n.environment === environment);
  const items = data.automatic
    .filter((n) => n.environment === environment)
    .map((n) => ({
      ...n,
      kind: "automatic",
      title: `${labels[n.resolvedAt ? "operational" : "outage"]} · ${n.component}`,
      body: n.resolvedAt
        ? "Two successful checks confirmed recovery."
        : "Two consecutive failed checks confirmed an incident.",
      startsAt: n.startedAt,
      endsAt: n.resolvedAt,
    }));
  for (const n of [...notes, ...items].sort(
    (a, b) => b.startsAt - a.startsAt,
  )) {
    const card = el("article", null, "incident");
    card.append(el("h3", n.title), time(n.startsAt), el("p", n.body));
    if (n.endsAt)
      card.append(
        el(
          "p",
          `${n.kind === "maintenance" ? "Ends" : "Recovered"} ${date(n.endsAt)}`,
          "caption",
        ),
      );
    if (n.incidentId)
      card.append(el("p", `Related incident: ${n.incidentId}`, "caption"));
    root.append(card);
  }
  if (!root.children.length)
    root.append(
      el("p", "No incidents or maintenance have been recorded.", "empty"),
    );
}
function readingState() {
  return ["availability", "activity-history"].map((id) => {
    const root = $("#" + id),
      details = root.querySelector("details"),
      wrap = root.querySelector(".table-scroll");
    return {
      id,
      open: details?.open,
      top: wrap?.scrollTop ?? 0,
      left: wrap?.scrollLeft ?? 0,
      focused:
        wrap && document.activeElement === wrap
          ? "table"
          : details &&
              document.activeElement === details.querySelector("summary")
            ? "summary"
            : null,
    };
  });
}
function restoreReading(states) {
  for (const state of states) {
    const root = $("#" + state.id),
      details = root.querySelector("details"),
      wrap = root.querySelector(".table-scroll");
    if (details) {
      details.open = !!state.open;
      if (state.focused === "summary")
        details.querySelector("summary").focus({ preventScroll: true });
    }
    if (wrap) {
      wrap.scrollTop = state.top;
      wrap.scrollLeft = state.left;
      if (state.focused === "table") wrap.focus({ preventScroll: true });
    }
  }
}
async function refresh() {
  const request = ++generation;
  if (
    renderedEnvironment !== environment ||
    renderedRange !== $("#range").value
  ) {
    for (const id of [
      "components",
      "availability",
      "activity-history",
      "incidents",
    ])
      $("#" + id).replaceChildren();
    for (const id of ["sessions", "players", "latency"])
      $("#" + id).textContent = "\u2014";
    $("#latency-detail").textContent = "Waiting for measurements";
    $("#monitoring-notice").hidden = true;
  }
  $("#notice").textContent = "Loading service observations…";
  try {
    const [status, history, incidents] = await Promise.all([
      get("/api/status"),
      get(`/api/history?environment=${environment}&range=${$("#range").value}`),
      get("/api/incidents"),
    ]);
    if (request !== generation) return;
    const config = status.environments[environment];
    const reading = readingState();
    $("#updated").textContent = `Updated ${date(status.generatedAt)}`;
    $("#components").replaceChildren();
    for (const c of config.components) {
      const row = el("article", null, "component"),
        badge = el("span", null, `badge ${c.state}`);
      badge.append(
        el("span", null, "dot"),
        document.createTextNode(labels[c.state]),
      );
      row.append(el("strong", c.label), badge, time(c.lastCheckedAt));
      $("#components").append(row);
    }
    const states = config.components.map((c) => c.state);
    const missing = config.components.filter(
      (c) => (c.measurementState ?? c.state) === "unknown",
    );
    $("#monitoring-notice").textContent = missing.length
      ? `Measurements unavailable for ${missing.map((c) => c.label).join(", ")}. Check the last observation times; maintenance does not establish monitoring freshness.`
      : "";
    $("#monitoring-notice").hidden = !missing.length;
    $("#notice").textContent = !config.launched
      ? "Production multiplayer has not launched yet. Select Staging to see current monitoring."
      : states.includes("outage")
        ? "A multiplayer service is experiencing an outage. See the incident history below."
        : states.includes("unknown")
          ? "Some services have no fresh observations. Availability is unknown for those services."
          : states.includes("maintenance")
            ? "Planned maintenance is in progress. Check observation times for monitoring freshness."
            : states.includes("degraded")
              ? "A check failed or a service is recovering. Further checks will confirm its status."
              : "All monitored services are operational.";
    const a = config.activity;
    $("#sessions").textContent =
      a.state === "available"
        ? number(a.sessions)
        : a.state === "suppressed"
          ? "Low activity"
          : "Unavailable";
    $("#players").textContent =
      a.state === "available"
        ? number(a.players)
        : a.state === "suppressed"
          ? "Low activity"
          : "Unavailable";
    const api = history.components.api;
    $("#latency").textContent =
      api.p50 == null ? "—" : `${Math.round(api.p50)} ms`;
    $("#latency-detail").textContent =
      api.p95 == null
        ? "No successful API timing samples"
        : `Median · p95 ${Math.round(api.p95)} ms · external probe, last ${Math.min(30, { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[$("#range").value])} days`;
    availability(history, config);
    activity(history);
    renderIncidents(incidents);
    restoreReading(reading);
    renderedEnvironment = environment;
    renderedRange = $("#range").value;
  } catch {
    if (request !== generation) return;
    $("#notice").textContent =
      "Status data is currently unavailable. Earlier displayed observations may be stale.";
    $("#updated").textContent = "Update failed";
    $("#monitoring-notice").textContent =
      "Monitoring freshness could not be verified.";
    $("#monitoring-notice").hidden = false;
    document.querySelectorAll(".badge").forEach((b) => {
      b.className = "badge unknown";
      b.replaceChildren(
        el("span", null, "dot"),
        document.createTextNode("Unknown"),
      );
    });
    $("#sessions").textContent = "Unavailable";
    $("#players").textContent = "Unavailable";
    $("#latency").textContent = "\u2014";
    $("#latency-detail").textContent = "Latest update unavailable";
  }
}
document.querySelectorAll("[data-environment]").forEach((button) =>
  button.addEventListener("click", () => {
    environment = button.dataset.environment;
    document
      .querySelectorAll("[data-environment]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    refresh();
  }),
);
$("#range").addEventListener("change", refresh);
refresh();
setInterval(refresh, 60000);
