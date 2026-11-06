import { publicActivity, bandText } from "./activity.js";
import { activityPlot, availabilityBuckets } from "./history-chart.js";

const $ = (selector) => document.querySelector(selector);
const buttons = [...document.querySelectorAll("[data-environment]")];
const range = $("#range");
const labels = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  maintenance: "Maintenance",
  unknown: "Unknown",
};
const barLabels = {
  pass: "Passed",
  fail: "Failed",
  mixed: "Passed and failed",
  partial: "Passed with gaps",
  gap: "No result",
  outside: "No check due",
};
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormat = new Intl.NumberFormat();
const date = (seconds) => dateFormat.format(seconds * 1000);
const number = (value) => numberFormat.format(value);

let environment;
let status;
let statusUnavailable = false;
let historyController;
let historyKey;
let historyLoaded = false;
let incidents;
let incidentsUnavailable = false;
let renderedIncidents;

function el(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function time(at) {
  const element = el("time", date(at));
  element.dateTime = new Date(at * 1000).toISOString();
  return element;
}

function message(selector, text) {
  const element = $(selector);
  if (element.textContent !== text) element.textContent = text;
  element.hidden = !text;
}

async function get(path, signal) {
  const deadline = AbortSignal.timeout(15000);
  const response = await fetch(path, {
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) throw new Error("Unavailable");
  return response.json();
}

function notice(state, title, detail = "") {
  $("#notice").dataset.state = state;
  message("#status-headline", title);
  message("#status-detail", detail);
}

function renderCurrent() {
  const config = status?.environments[environment];
  for (const id of [
    "#services-section",
    "#history-section",
    "#activity-section",
  ])
    $(id).hidden = !config?.launched;
  const stagingOnly =
    environment === "staging" &&
    status &&
    !status.environments.production.launched;
  message(
    "#environment-note",
    stagingOnly
      ? "Staging is the test environment. Production has yet to launch."
      : "",
  );
  if (statusUnavailable) {
    notice(
      "unknown",
      "Current status unavailable",
      "This page will try again shortly.",
    );
  } else if (!config) {
    notice("unknown", "Loading status…");
  } else if (!config.launched) {
    notice(
      "unknown",
      `${config.label} has yet to launch`,
      status.environments.staging.launched
        ? "Select Staging to see its checks."
        : "",
    );
  } else {
    const states = config.components.map((check) => check.state);
    if (states.includes("outage"))
      notice(
        "outage",
        "Service outage",
        "See incidents and current checks below.",
      );
    else if (states.includes("degraded"))
      notice(
        "degraded",
        "Service degraded",
        "A check failed or recovery is still being confirmed.",
      );
    else if (states.includes("maintenance"))
      notice("maintenance", "Maintenance in progress");
    else if (states.includes("unknown"))
      notice("unknown", "Some checks are unavailable");
    else notice("operational", "All monitored services operational");
  }
  if (!config?.launched) return;

  message(
    "#updated",
    statusUnavailable
      ? `Last update ${date(status.generatedAt)}`
      : `As of ${date(status.generatedAt)}`,
  );
  $("#components").replaceChildren(
    ...config.components.map((check) => {
      const row = el("li", null, "component");
      const state = statusUnavailable ? "unknown" : check.state;
      const last = el("span", null, "last-check caption");
      if (check.lastCheckedAt == null) last.textContent = "No check yet";
      else last.append("Checked ", time(check.lastCheckedAt));
      row.append(
        el("strong", check.label),
        el("span", labels[state], `badge ${state}`),
        last,
      );
      return row;
    }),
  );
  const missing = config.components.filter(
    (check) =>
      check.state === "maintenance" && check.measurementState === "unknown",
  );
  message(
    "#monitoring-notice",
    !statusUnavailable && missing.length
      ? `No recent checks during maintenance for ${missing.map((check) => check.label).join(", ")}.`
      : "",
  );
  renderActivitySummary(config.activity);
}

function renderActivitySummary(value) {
  const activity = publicActivity(value);
  const root = $("#activity-current");
  root.replaceChildren();
  if (statusUnavailable || !activity || activity.state === "unavailable") {
    root.append(el("p", "No recent activity estimate.", "muted"));
    return;
  }
  if (activity.state === "suppressed") {
    root.append(el("p", "Activity is below the privacy threshold.", "muted"));
  } else {
    const totals = el("dl", null, "activity-totals");
    for (const [label, value] of [
      ["Public sessions", activity.sessionsBand],
      ["Public players", activity.playersBand],
    ]) {
      const total = el("div");
      total.append(el("dt", label, "caption"), el("dd", bandText(value)));
      totals.append(total);
    }
    root.append(totals);
  }
  const sample = el("p", "Sample from ", "caption activity-sample");
  sample.append(time(activity.sampledAt));
  root.append(sample);
}

function table(label, headers, rows, total = rows.length) {
  const details = el("details");
  const summary = el("summary", label);
  const wrap = el("div", null, "table-scroll");
  const t = el("table");
  const head = t.createTHead().insertRow();
  for (const header of headers) {
    const cell = el("th", header);
    cell.scope = "col";
    head.append(cell);
  }
  details.append(summary);
  if (total > rows.length)
    details.append(
      el(
        "p",
        `Showing the latest ${number(rows.length)} of ${number(total)} samples.`,
        "caption",
      ),
    );
  const body = t.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    const first = el("th", cells[0]);
    first.scope = "row";
    row.append(first);
    for (const value of cells.slice(1)) row.insertCell().textContent = value;
  }
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", label);
  wrap.append(t);
  details.append(wrap);
  return details;
}

function bar(state) {
  const element = el("span", null, `bar ${state}`);
  element.setAttribute("aria-hidden", "true");
  return element;
}

function availability(history, components) {
  const root = $("#availability");
  root.replaceChildren(
    el(
      "p",
      `${date(history.from)} – ${date(history.to)}`,
      "caption history-window",
    ),
  );
  const rows = [];
  for (const component of components) {
    const stats = history.components[component.id];
    const row = el("div", null, "history-row");
    const name = el("div", component.label);
    if (stats.startedAt != null && stats.startedAt > history.from) {
      const started = el("span", "Since ", "caption monitoring-start");
      started.append(time(stats.startedAt));
      name.append(started);
    }
    const bars = el("div", null, "bars");
    bars.setAttribute("aria-hidden", "true");
    for (const bucket of availabilityBuckets(
      history,
      stats,
      component.cadence,
    )) {
      const swatch = bar(bucket.state);
      const gap = Math.max(0, bucket.expected - bucket.passed - bucket.failed);
      swatch.title = `${date(bucket.from)} – ${date(bucket.to)}. ${barLabels[bucket.state]}. ${bucket.passed} passed, ${bucket.failed} failed, ${gap} without a result.`;
      bars.append(swatch);
      rows.push([
        component.label,
        date(bucket.from),
        date(bucket.to),
        barLabels[bucket.state],
        bucket.passed,
        bucket.failed,
        gap,
      ]);
    }
    const counts = el("div", null, "numbers");
    counts.append(
      el(
        "strong",
        stats.uptime == null
          ? "No results"
          : `${stats.uptime.toFixed(2)}% uptime`,
      ),
    );
    if (stats.coverage != null)
      counts.append(
        el("span", `${stats.coverage.toFixed(1)}% coverage`, "caption"),
      );
    row.append(name, bars, counts);
    root.append(row);
  }
  const legend = el("ul", null, "legend caption");
  for (const [state, label] of Object.entries(barLabels)) {
    const item = el("li");
    item.append(bar(state), label);
    legend.append(item);
  }
  root.append(
    legend,
    el(
      "p",
      "Uptime uses completed checks with a pass or fail. Coverage compares those results with the checks due since monitoring began.",
      "caption",
    ),
    table(
      "Check counts by time",
      ["Service", "From", "To", "Result", "Passed", "Failed", "No result"],
      rows,
    ),
  );
}

function activityHistory(history, query) {
  const root = $("#activity-history");
  root.replaceChildren();
  const rows = history.activity.map(publicActivity).filter(Boolean);
  history = { ...history, activity: rows };
  if (!rows.length) {
    root.append(el("p", "No activity samples in this window.", "empty"));
    return;
  }
  const plot = activityPlot(history);
  if (plot) {
    const ns = "http://www.w3.org/2000/svg";
    const figure = el("figure", null, "activity-figure");
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 1000 150");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.classList.add("chart");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      "Lower bounds of public player bands over time. Gaps show periods without published bands.",
    );
    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", plot.path);
    svg.append(line);
    figure.append(
      svg,
      el(
        "figcaption",
        `Public player band lower bounds · peak band ${bandText({ min: plot.peak, max: plot.peak + 9 })} · ${date(history.from)} – ${date(history.to)}`,
        "caption chart-window",
      ),
    );
    root.append(figure);
  } else {
    root.append(
      el("p", "No player bands were published in this window.", "empty"),
    );
  }
  root.append(
    table(
      "Activity samples",
      ["Sample time", "Sessions", "Players", "Status"],
      rows.slice(-288).map((sample) => [
        date(sample.sampledAt),
        bandText(sample.sessionsBand),
        bandText(sample.playersBand),
        {
          available: "Published",
          suppressed: "Withheld",
          unavailable: "Unavailable",
        }[sample.state],
      ]),
      rows.length,
    ),
  );
  if (rows.length > 288) {
    const full = el("a", "All activity samples (JSON)", "caption");
    full.href = `/api/history?${query}`;
    root.querySelector("details").append(full);
  }
}

function renderIncidents() {
  if (!incidents || !environment) {
    message(
      "#incidents-message",
      incidentsUnavailable
        ? "Incident history unavailable."
        : incidents
          ? "Select an environment to see its incidents."
          : "Loading incidents…",
    );
    return;
  }
  const notes = incidents.notes.filter(
    (note) => note.environment === environment,
  );
  const automatic = incidents.automatic.filter(
    (incident) => incident.environment === environment,
  );
  const components = status?.environments[environment].components ?? [];
  const names = Object.fromEntries(
    components.map((check) => [check.id, check.label]),
  );
  const key = JSON.stringify([environment, notes, automatic, names]);
  message(
    "#incidents-message",
    incidentsUnavailable
      ? "Couldn’t refresh incidents. Showing the last update."
      : notes.length || automatic.length
        ? ""
        : "No incidents or maintenance recorded.",
  );
  if (renderedIncidents === key) return;
  const root = $("#incidents");
  const items = [
    ...notes,
    ...automatic.map((incident) => ({
      ...incident,
      kind: "automatic",
      startsAt: incident.startedAt,
      endsAt: incident.resolvedAt,
      title: `${incident.resolvedAt == null ? "Outage" : "Resolved"} · ${names[incident.component] ?? incident.component}`,
    })),
  ];
  root.replaceChildren(
    ...items
      .sort((a, b) => b.startsAt - a.startsAt)
      .map((item) => {
        const entry = el("article", null, "incident");
        entry.id = `incident-${item.id}`;
        entry.tabIndex = -1;
        const stamp = el("p", null, "caption");
        if (item.kind === "maintenance") stamp.append("Maintenance · ");
        stamp.append(time(item.startsAt));
        entry.append(el("h3", item.title), stamp);
        if (item.kind === "automatic") {
          const confirmed = el("p", "Confirmed ", "caption");
          confirmed.append(time(item.confirmedAt));
          entry.append(confirmed);
        } else entry.append(el("p", item.body, "body"));
        if (item.endsAt != null) {
          const end = el(
            "p",
            item.kind === "automatic" ? "Recovered " : "End ",
            "caption",
          );
          end.append(time(item.endsAt));
          entry.append(end);
        }
        if (
          item.incidentId &&
          automatic.some((incident) => incident.id === item.incidentId)
        ) {
          const link = el("a", "Related incident", "caption");
          link.href = `#incident-${item.incidentId}`;
          entry.append(link);
        }
        return entry;
      }),
  );
  renderedIncidents = key;
}

function preserveTables(update) {
  const roots = [$("#availability"), $("#activity-history")];
  const reading = roots.map((root) => {
    const details = root.querySelector("details");
    const wrap = details?.querySelector(".table-scroll");
    return {
      open: details?.open,
      top: wrap?.scrollTop,
      left: wrap?.scrollLeft,
      focused:
        details?.contains(document.activeElement) &&
        document.activeElement.tagName,
    };
  });
  update();
  roots.forEach((root, index) => {
    const previous = reading[index];
    const details = root.querySelector("details");
    if (!details || !previous) return;
    details.open = !!previous.open;
    const wrap = details.querySelector(".table-scroll");
    if (previous.top != null) wrap.scrollTop = previous.top;
    if (previous.left != null) wrap.scrollLeft = previous.left;
    if (previous.focused === "DIV") wrap.focus({ preventScroll: true });
    if (previous.focused === "SUMMARY")
      details.querySelector("summary").focus({ preventScroll: true });
    if (previous.focused === "A")
      (details.querySelector("a") ?? details.querySelector("summary")).focus({
        preventScroll: true,
      });
  });
}

async function refreshHistory() {
  historyController?.abort();
  const config = status?.environments[environment];
  if (!config?.launched) return;
  const controller = new AbortController();
  historyController = controller;
  const key = `environment=${environment}&range=${range.value}`;
  if (historyKey !== key) {
    historyKey = key;
    historyLoaded = false;
    $("#availability").replaceChildren();
    $("#activity-history").replaceChildren();
    message("#latency-detail", "");
  }
  if (!historyLoaded) message("#history-message", "Loading history…");
  try {
    const history = await get(`/api/history?${key}`, controller.signal);
    if (controller.signal.aborted) return;
    if (
      history.environment !== environment ||
      !Number.isFinite(history.from) ||
      !(history.to > history.from) ||
      !Array.isArray(history.activity) ||
      config.components.some(
        ({ id }) => !Array.isArray(history.components?.[id]?.points),
      )
    )
      throw new Error("Invalid history");
    preserveTables(() => {
      availability(history, config.components);
      activityHistory(history, key);
    });
    const api = history.components.api;
    message(
      "#latency-detail",
      api.p50 == null
        ? ""
        : `API and server browser · ${Math.round(api.p50)} ms median · ${Math.round(api.p95)} ms p95${range.value === "90d" ? " · last 30 days" : ""}`,
    );
    historyLoaded = true;
    message("#history-message", "");
  } catch {
    if (controller.signal.aborted) return;
    message(
      "#history-message",
      historyLoaded
        ? "Couldn’t refresh uptime and activity history. Showing the last update."
        : "Uptime and activity history unavailable.",
    );
  }
}

function selectEnvironment(value) {
  environment = value;
  for (const button of buttons)
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.environment === value),
    );
  renderCurrent();
  renderIncidents();
  void refreshHistory();
}

async function refreshStatus() {
  try {
    const previous = status?.environments[environment];
    const next = await get("/api/status");
    if (!next.environments?.staging || !next.environments.production)
      throw new Error("Invalid status");
    status = next;
    statusUnavailable = false;
    if (!environment) {
      selectEnvironment(
        next.environments.production.launched ? "production" : "staging",
      );
    } else {
      renderCurrent();
      renderIncidents();
      if (previous?.launched !== status.environments[environment].launched)
        void refreshHistory();
    }
  } catch {
    statusUnavailable = true;
    renderCurrent();
  }
}

async function refreshIncidents() {
  try {
    const next = await get("/api/incidents");
    if (!Array.isArray(next.automatic) || !Array.isArray(next.notes))
      throw new Error("Invalid incidents");
    incidents = next;
    incidentsUnavailable = false;
  } catch {
    incidentsUnavailable = true;
  }
  renderIncidents();
}

for (const button of buttons)
  button.addEventListener("click", () => {
    if (button.dataset.environment !== environment)
      selectEnvironment(button.dataset.environment);
  });
range.addEventListener("change", refreshHistory);
void refreshStatus();
void refreshIncidents();
setInterval(refreshStatus, 60000);
setInterval(refreshIncidents, 60000);
setInterval(() => {
  if (range.value === "24h") void refreshHistory();
}, 300000);
