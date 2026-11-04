import { test } from "node:test";
import assert from "node:assert/strict";
import { database } from "./support/db.js";
import worker from "../src/worker.js";
import {
  componentState,
  validateObservation,
  validateActivity,
  validateNotes,
} from "../src/domain.js";
import { ingest, current, history, incidents, retain } from "../src/store.js";
const NOW = 1893456000,
  token = "test-only-ingest-token-never-a-real-secret";
const envs = {
  staging: { label: "Staging", launched: true },
  production: { label: "Production", launched: false },
};
const observation = (at, outcome, component = "api") => ({
  environment: "staging",
  observedAt: at,
  runId: String(at),
  components: [
    {
      component,
      outcome,
      reason:
        outcome === "pass"
          ? "ok"
          : outcome === "blocked"
            ? "dependency"
            : "timeout",
      latencyMs: outcome === "pass" ? 50 : null,
    },
  ],
  activity: null,
});
test("two adjacent failures open one incident; two adjacent successes recover it", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "fail"));
    assert.equal(
      (await current(db, envs, [], NOW)).environments.staging.components[0]
        .state,
      "degraded",
    );
    await ingest(db, observation(NOW + 300, "fail"));
    await ingest(db, observation(NOW + 300, "fail"));
    let result = await incidents(db, [], NOW + 300);
    assert.equal(result.automatic.length, 1);
    assert.equal(result.automatic[0].startedAt, NOW);
    assert.equal(result.automatic[0].resolvedAt, null);
    assert.equal(
      (await current(db, envs, [], NOW + 300)).environments.staging
        .components[0].state,
      "outage",
    );
    await ingest(db, observation(NOW + 600, "pass"));
    assert.equal(
      (await current(db, envs, [], NOW + 600)).environments.staging
        .components[0].state,
      "degraded",
    );
    await ingest(db, observation(NOW + 900, "pass"));
    assert.equal(
      (await incidents(db, [], NOW + 900)).automatic[0].resolvedAt,
      NOW + 900,
    );
    assert.equal(
      (await current(db, envs, [], NOW + 900)).environments.staging
        .components[0].state,
      "operational",
    );
  } finally {
    db.close();
  }
});
test("missed slots and blocked checks remain unknown and reduce coverage", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "pass"));
    await ingest(db, observation(NOW + 600, "blocked"));
    const h = await history(db, "staging", 86400, NOW + 600);
    assert.equal(h.components.api.passed, 1);
    assert.equal(h.components.api.failed, 0);
    assert.equal(h.components.api.expected, 3);
    assert.equal(h.components.api.uptime, 100);
    assert.ok(Math.abs(h.components.api.coverage - 100 / 3) < 0.001);
    assert.equal(
      (await current(db, envs, [], NOW + 600)).environments.staging
        .components[0].state,
      "unknown",
    );
    assert.equal(
      componentState(
        [{ slot: NOW, observed_at: NOW, outcome: "pass" }],
        NOW + 900,
        300,
        true,
      ),
      "unknown",
    );
  } finally {
    db.close();
  }
});
test("a scheduling gap cannot confirm an incident or recovery", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "fail"));
    await ingest(db, observation(NOW + 600, "fail"));
    assert.equal((await incidents(db, [], NOW + 600)).automatic.length, 0);
    await ingest(db, observation(NOW + 900, "fail"));
    await ingest(db, observation(NOW + 1500, "pass"));
    assert.equal(
      (await current(db, envs, [], NOW + 1500)).environments.staging
        .components[0].state,
      "degraded",
    );
  } finally {
    db.close();
  }
});
test("duplicate slots are immutable and late observations cannot rewrite incident transitions", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "fail"));
    await ingest(db, observation(NOW + 2, "pass"));
    await ingest(db, observation(NOW + 600, "pass"));
    await ingest(db, observation(NOW + 300, "fail"));
    const h = await history(db, "staging", 86400, NOW + 600);
    assert.equal(h.components.api.failed, 2);
    assert.equal(h.components.api.passed, 1);
    assert.equal((await incidents(db, [], NOW + 600)).automatic.length, 0);
  } finally {
    db.close();
  }
});
test("maintenance preserves measured failures and production never starts green", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "fail"));
    const notes = [
      {
        environment: "staging",
        kind: "maintenance",
        components: ["api"],
        startsAt: NOW - 1,
        endsAt: NOW + 300,
      },
    ];
    const s = await current(db, envs, notes, NOW);
    assert.equal(s.environments.staging.components[0].state, "maintenance");
    assert.ok(
      s.environments.production.components.every(
        (c) => c.state === "not-yet-launched",
      ),
    );
    assert.equal(
      (await history(db, "staging", 86400, NOW)).components.api.uptime,
      0,
    );
  } finally {
    db.close();
  }
});
test("activity validation enforces delay and suppression before ingestion", () => {
  const a = {
    schema: "topiaforge.activity/1",
    sampledAt: NOW - 900,
    state: "available",
    sessions: 5,
    players: 10,
  };
  assert.equal(
    validateActivity({ ...a, serverId: "must-be-stripped" }, NOW).serverId,
    undefined,
  );
  for (const invalid of [
    { ...a, sampledAt: NOW },
    { ...a, sessions: 4 },
    { ...a, players: 9 },
    { ...a, state: "suppressed" },
    { ...a, state: "unavailable" },
  ])
    assert.throws(() => validateActivity(invalid, NOW));
  assert.deepEqual(
    validateActivity(
      { ...a, state: "suppressed", sessions: null, players: null },
      NOW,
    ),
    {
      sampledAt: NOW - 900,
      state: "suppressed",
      sessions: null,
      players: null,
    },
  );
});
test("all public endpoints expose only released counts and fixed observation fields", async (t) => {
  const db = database();
  t.after(() => db.close());
  t.mock.method(Date, "now", () => NOW * 1000);
  const env = { DB: db, INGEST_TOKEN: token };
  const a = {
    schema: "topiaforge.activity/1",
    sampledAt: NOW - 900,
    state: "suppressed",
    sessions: null,
    players: null,
    secret: "never persist",
  };
  const v = {
    ...observation(NOW, "pass"),
    activity: a,
    privateKey: "never persist",
  };
  const request = new Request("https://status.example/internal/observations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(v),
  });
  assert.equal((await worker.fetch(request, env)).status, 200);
  for (const path of [
    "/api/status",
    "/api/history?environment=staging&range=24h",
    "/api/incidents",
  ]) {
    const response = await worker.fetch(
      new Request(`https://status.example${path}`),
      env,
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /never persist|privateKey|serverId/);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
  const s = await current(db, envs, [], NOW);
  assert.equal(s.environments.staging.activity.state, "suppressed");
  assert.equal(
    (await current(db, envs, [], NOW + 1000)).environments.staging.activity
      .state,
    "unavailable",
  );
});
test("write credentials, body bounds, disabled environments and route validation fail closed", async (t) => {
  const db = database();
  t.after(() => db.close());
  t.mock.method(Date, "now", () => NOW * 1000);
  const env = { DB: db, INGEST_TOKEN: token };
  for (const headers of [{}, { authorization: "Bearer wrong" }])
    assert.equal(
      (
        await worker.fetch(
          new Request("https://status.example/internal/observations", {
            method: "POST",
            headers,
          }),
          env,
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://status.example/api/history?environment=staging&range=24h&range=7d",
        ),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request(
          "https://status.example/api/history?environment=staging&range=forever",
        ),
        env,
      )
    ).status,
    400,
  );
  assert.throws(() =>
    validateObservation(
      { ...observation(NOW, "pass"), environment: "production" },
      NOW,
      envs,
    ),
  );
  const oversized = new Request(
    "https://status.example/internal/observations",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(17000) }),
    },
  );
  assert.equal((await worker.fetch(oversized, env)).status, 400);
});
test("durable run claims prevent repeat traffic, including after a failed run", async (t) => {
  const db = database();
  t.after(() => db.close());
  t.mock.method(Date, "now", () => NOW * 1000);
  const env = { DB: db, INGEST_TOKEN: token };
  const req = () =>
    new Request("https://status.example/internal/claim", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ environment: "staging", mode: "full" }),
    });
  assert.equal((await (await worker.fetch(req(), env)).json()).acquired, true);
  assert.equal((await (await worker.fetch(req(), env)).json()).acquired, false);
});
test("retention archives detailed rows once and keeps 90-day history", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW - 40 * 86400, "pass"));
    await ingest(db, observation(NOW - 40 * 86400 + 300, "fail"));
    await retain(db, NOW);
    await retain(db, NOW);
    const h = await history(db, "staging", 90 * 86400, NOW);
    assert.equal(h.components.api.passed, 1);
    assert.equal(h.components.api.failed, 1);
    assert.equal(h.components.api.points.length, 0);
    assert.equal(h.components.api.daily.length, 1);
    await retain(db, NOW + 60 * 86400);
    assert.equal(
      (await history(db, "staging", 90 * 86400, NOW + 60 * 86400)).components
        .api.daily.length,
      0,
    );
  } finally {
    db.close();
  }
});
test("incident notes reject duplicate IDs, invalid windows and unknown services", () => {
  const note = {
    id: "maintenance-example",
    environment: "staging",
    kind: "maintenance",
    title: "Service work",
    body: "A short explanation.",
    components: ["api"],
    startsAt: NOW,
    endsAt: NOW + 300,
    incidentId: null,
  };
  assert.equal(validateNotes([note], envs).length, 1);
  for (const value of [
    [note, note],
    [{ ...note, endsAt: NOW }],
    [{ ...note, components: ["database"] }],
  ])
    assert.throws(() => validateNotes(value, envs));
});
