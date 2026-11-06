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

test("a storage failure cannot commit an observation without its incident transition", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "fail"));
    const prepare = db.prepare.bind(db);
    let failOnce = true;
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes("INTO incidents")) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          if (failOnce) {
            failOnce = false;
            throw new Error("injected storage interruption");
          }
          return run();
        };
      }
      return statement;
    };
    await assert.rejects(
      () => ingest(db, observation(NOW + 300, "fail")),
      /storage interruption/,
    );
    await ingest(db, observation(NOW + 300, "fail"));
    assert.equal((await incidents(db, [], NOW + 300)).automatic.length, 1);
  } finally {
    db.close();
  }
});

test("optional stale activity cannot discard a valid reliability observation", async (t) => {
  const db = database();
  t.after(() => db.close());
  t.mock.method(Date, "now", () => NOW * 1000);
  const payload = {
    ...observation(NOW, "pass"),
    activity: {
      schema: "topiaforge.activity/1",
      sampledAt: NOW - 86700,
      state: "suppressed",
      sessions: null,
      players: null,
    },
  };
  const response = await worker.fetch(
    new Request("https://status.example/internal/observations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
    { DB: db, INGEST_TOKEN: token },
  );
  assert.equal(response.status, 200);
  const data = await history(db, "staging", 86400, NOW);
  assert.equal(data.components.api.passed, 1);
  assert.equal(data.activity.length, 0);
});

test("archived calendar-day counts cannot leak into a narrower 90-day view", async () => {
  const db = database();
  const now = NOW + 43200;
  try {
    await ingest(db, observation(NOW - 90 * 86400 + 300, "pass"));
    await retain(db, now - 86400);
    const data = await history(db, "staging", 90 * 86400, now);
    assert.equal(data.components.api.passed, 0);
    assert.equal(data.from, Math.ceil((now - 90 * 86400) / 86400) * 86400);
  } finally {
    db.close();
  }
});

test("delayed detailed cleanup cannot extend the 30-day latency window", async () => {
  const db = database();
  try {
    const old = observation(NOW - 31 * 86400, "pass");
    old.components[0].latencyMs = 9000;
    await ingest(db, old);
    await ingest(db, observation(NOW, "pass"));
    const data = await history(db, "staging", 90 * 86400, NOW);
    assert.equal(data.components.api.passed, 2);
    assert.equal(data.components.api.p95, 50);
  } finally {
    db.close();
  }
});

test("an unresolved incident remains visible after hundreds of newer recoveries", async () => {
  const db = database();
  try {
    await db
      .prepare("INSERT INTO incidents VALUES (?,?,?,?,?,NULL)")
      .bind("old-open", "staging", "relay", NOW - 10000, NOW - 9000)
      .run();
    for (let i = 0; i < 201; i++)
      await db
        .prepare("INSERT INTO incidents VALUES (?,?,?,?,?,?)")
        .bind(`resolved-${i}`, "staging", "api", NOW + i, NOW + i, NOW + i + 1)
        .run();
    assert.ok(
      (await incidents(db, [], NOW + 500)).automatic.some(
        (i) => i.id === "old-open",
      ),
    );
  } finally {
    db.close();
  }
});

test("retention between separate reads cannot double-count archived observations", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW - 40 * 86400, "pass"));
    const prepare = db.prepare.bind(db);
    let injected = false;
    db.prepare = (sql) => {
      const statement = prepare(sql),
        all = statement.all.bind(statement);
      if (sql.startsWith("SELECT * FROM observations"))
        statement.all = async () => {
          const result = await all();
          if (!injected) {
            injected = true;
            await retain(db, NOW);
          }
          return result;
        };
      return statement;
    };
    const data = await history(db, "staging", 90 * 86400, NOW);
    assert.equal(data.components.api.passed, 1);
  } finally {
    db.close();
  }
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
test("coverage excludes the slot still in progress until its check arrives", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "pass"));
    const read = async (now) =>
      (await history(db, "staging", 86400, now)).components.api;
    assert.equal((await read(NOW + 301)).expected, 1);
    assert.equal((await read(NOW + 301)).coverage, 100);
    assert.equal((await read(NOW + 600)).expected, 2);
    await ingest(db, observation(NOW + 605, "pass"));
    assert.equal((await read(NOW + 602)).expected, 2);
    assert.equal((await read(NOW + 605)).expected, 3);
  } finally {
    db.close();
  }
});
test("a check outside a rolling window cannot change its uptime or coverage", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW + 20, "fail"));
    await ingest(db, observation(NOW + 300, "pass"));
    const result = (await history(db, "staging", 86400, NOW + 86400 + 50))
      .components.api;
    assert.equal(result.uptime, 100);
    assert.equal(result.failed, 0);
    assert.equal(result.expected, 287);
    assert.equal(result.points.length, 1);
    const boundary = (await history(db, "staging", 86400, NOW + 86400 + 10))
      .components.api;
    assert.equal(boundary.uptime, 50);
    assert.equal(boundary.expected, 288);
  } finally {
    db.close();
  }
});
test("incidents and current status agree before a skewed observation becomes visible", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "fail"));
    await ingest(db, observation(NOW + 300, "fail"));
    assert.deepEqual((await incidents(db, [], NOW + 285)).automatic, []);
    assert.equal(
      (await current(db, envs, [], NOW + 285)).environments.staging
        .components[0].state,
      "degraded",
    );
    await ingest(db, observation(NOW + 600, "pass"));
    await ingest(db, observation(NOW + 900, "pass"));
    assert.equal(
      (await incidents(db, [], NOW + 885)).automatic[0].resolvedAt,
      null,
    );
    assert.equal(
      (await current(db, envs, [], NOW + 885)).environments.staging
        .components[0].state,
      "degraded",
    );
    assert.equal(
      (await incidents(db, [], NOW + 900)).automatic[0].resolvedAt,
      NOW + 900,
    );
  } finally {
    db.close();
  }
});
test("the newest adjacent pair can open and recover an incident in either delivery order", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW + 300, "fail"));
    await ingest(db, observation(NOW, "fail"));
    const opened = (await incidents(db, [], NOW + 300)).automatic[0];
    assert.equal(opened.startedAt, NOW);
    assert.equal(opened.confirmedAt, NOW + 300);
    await ingest(db, observation(NOW + 900, "pass"));
    await ingest(db, observation(NOW + 600, "pass"));
    const recovered = (await incidents(db, [], NOW + 900)).automatic[0];
    assert.equal(recovered.id, opened.id);
    assert.equal(recovered.resolvedAt, NOW + 900);
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
test("a discarded duplicate cannot move the first measurement earlier", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW + 10, "pass"));
    await ingest(db, observation(NOW + 1, "fail"));
    const h = await history(db, "staging", 86400, NOW + 20);
    assert.equal(h.components.api.startedAt, NOW + 10);
    assert.equal(h.components.api.passed, 1);
  } finally {
    db.close();
  }
});
test("maintenance keeps unavailable measurement evidence explicit", async () => {
  const db = database();
  try {
    await ingest(db, observation(NOW, "pass"));
    await ingest(db, observation(NOW, "blocked", "discovery"));
    const notes = [
      {
        environment: "staging",
        kind: "maintenance",
        components: ["api", "discovery", "invites", "signaling", "relay"],
        startsAt: NOW - 1,
        endsAt: null,
      },
    ];
    const fresh = (await current(db, envs, notes, NOW)).environments.staging
      .components;
    assert.equal(
      fresh.find((c) => c.id === "api").measurementState,
      "operational",
    );
    assert.equal(
      fresh.find((c) => c.id === "discovery").measurementState,
      "unknown",
    );
    const stale = (await current(db, envs, notes, NOW + 1800)).environments
      .staging.components;
    assert.ok(stale.every((c) => c.state === "maintenance"));
    assert.ok(stale.every((c) => c.measurementState === "unknown"));
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
  for (const value of [
    { ...observation(NOW, "pass"), environment: ["staging"] },
    { ...observation(NOW, "pass"), runId: NOW },
    observation(NOW, "pass", ["api"]),
  ])
    assert.throws(() => validateObservation(value, NOW, envs));
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
test("claims and retried writes keep their slot across a clock boundary", async (t) => {
  const db = database();
  t.after(() => db.close());
  let now = NOW + 1;
  t.mock.method(Date, "now", () => now * 1000);
  const env = { DB: db, INGEST_TOKEN: token };
  const post = (path, value) =>
    worker.fetch(
      new Request(`https://status.example/internal/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      }),
      env,
    );
  const claim = {
    environment: "staging",
    mode: "basic",
    observedAt: NOW - 1,
    runId: "123-1",
  };
  const slot = NOW - 300;
  const reserve = async (value) => {
    const response = await post("run-claim", value);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await reserve(claim), { acquired: true, slot });
  assert.deepEqual(await reserve(claim), { acquired: true, slot });
  assert.deepEqual(await reserve({ ...claim, runId: "124-1" }), {
    acquired: false,
    slot,
  });
  const report = { ...observation(claim.observedAt, "pass"), ...claim, slot };
  assert.equal(
    (await post("observations", { ...report, slot: NOW })).status,
    400,
  );
  assert.equal(
    (await post("observations", { ...report, runId: "124-1" })).status,
    409,
  );
  assert.equal(
    (await post("observations", observation(claim.observedAt, "fail"))).status,
    200,
  );
  assert.equal(
    (await history(db, "staging", 86400, now)).components.api.points.length,
    0,
  );
  assert.equal((await post("observations", report)).status, 200);
  assert.equal((await post("observations", report)).status, 200);
  assert.deepEqual(await reserve(claim), { acquired: false, slot });
  const latest = (await history(db, "staging", 86400, now)).components.api;
  assert.deepEqual(latest.points, [
    { at: slot, outcome: "pass", latencyMs: 50 },
  ]);
  assert.equal(latest.startedAt, NOW - 1);
  assert.equal(
    (await post("claim", { environment: "staging", mode: "basic" })).status,
    200,
  );
  assert.deepEqual(await reserve({ ...claim, observedAt: NOW + 1 }), {
    acquired: false,
    slot: NOW,
  });
  now += 61;
  assert.equal((await post("run-claim", claim)).status, 400);
});
test("legacy and new full probes share a lease across adjacent slots", async (t) => {
  const db = database();
  t.after(() => db.close());
  let now = NOW - 1;
  t.mock.method(Date, "now", () => now * 1000);
  const env = { DB: db, INGEST_TOKEN: token };
  const post = async (path, value) => {
    const response = await worker.fetch(
      new Request(`https://status.example/internal/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      }),
      env,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const legacy = { environment: "staging", mode: "full" };
  assert.equal((await post("claim", legacy)).acquired, true);
  now = NOW + 1;
  const next = { ...legacy, observedAt: now, runId: "125-1" };
  assert.equal((await post("run-claim", next)).acquired, false);
  const components = ["discovery", "invites", "signaling", "relay"].map(
    (component) => observation(NOW - 1, "pass", component).components[0],
  );
  await post("observations", { ...observation(NOW - 1, "pass"), components });
  assert.equal((await post("run-claim", next)).acquired, true);
  assert.equal((await post("run-claim", next)).acquired, true);

  now = NOW + 1199;
  assert.equal(
    (await post("run-claim", { ...next, observedAt: now, runId: "126-1" }))
      .acquired,
    true,
  );
  now = NOW + 1201;
  assert.equal((await post("claim", legacy)).acquired, false);
  now = NOW + 1439;
  assert.equal((await post("claim", legacy)).acquired, true);
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
