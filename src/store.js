import { COMPONENTS, componentState, summary } from "./domain.js";
const DAY = 86400;
const all = async (db, sql, ...args) =>
  (
    await db
      .prepare(sql)
      .bind(...args)
      .all()
  ).results;
export async function ingest(db, value) {
  const statements = [];
  for (const c of value.components) {
    const cadence = COMPONENTS[c.component].cadence;
    const slot = Math.floor(value.observedAt / cadence) * cadence;
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?,?,?)")
        .bind(
          value.environment,
          c.component,
          slot,
          value.observedAt,
          c.outcome,
          c.latencyMs,
          c.reason,
          value.runId,
        ),
      db
        .prepare(
          "INSERT INTO monitor_start VALUES (?,?,?) ON CONFLICT(environment,component) DO UPDATE SET started_at = MIN(started_at, excluded.started_at)",
        )
        .bind(value.environment, c.component, value.observedAt),
      db
        .prepare(
          `WITH newest AS (
        SELECT * FROM observations WHERE environment = ? AND component = ? ORDER BY slot DESC LIMIT 2
      ) INSERT OR IGNORE INTO incidents
        SELECT a.environment || '-' || a.component || '-' || b.slot,a.environment,a.component,b.observed_at,a.observed_at,NULL
        FROM newest a JOIN newest b ON a.slot = b.slot + ?
        WHERE a.slot = ? AND a.outcome = 'fail' AND b.outcome = 'fail'`,
        )
        .bind(value.environment, c.component, cadence, slot),
      db
        .prepare(
          `WITH newest AS (
        SELECT * FROM observations WHERE environment = ? AND component = ? ORDER BY slot DESC LIMIT 2
      ) UPDATE incidents SET resolved_at = (
        SELECT a.observed_at FROM newest a JOIN newest b ON a.slot = b.slot + ?
        WHERE a.slot = ? AND a.outcome = 'pass' AND b.outcome = 'pass'
      ) WHERE environment = ? AND component = ? AND resolved_at IS NULL
        AND started_at < ? AND EXISTS (
          SELECT 1 FROM newest a JOIN newest b ON a.slot = b.slot + ?
          WHERE a.slot = ? AND a.outcome = 'pass' AND b.outcome = 'pass'
        )`,
        )
        .bind(
          value.environment,
          c.component,
          cadence,
          slot,
          value.environment,
          c.component,
          value.observedAt,
          cadence,
          slot,
        ),
    );
  }
  if (value.activity) {
    const a = value.activity;
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO activity VALUES (?,?,?,?,?)")
        .bind(value.environment, a.sampledAt, a.state, a.sessions, a.players),
    );
  }
  // D1 batch commits observations and incident transitions together. Retrying a
  // failed delivery cannot leave its incident permanently missing or unresolved.
  await db.batch(statements);
}
export const recent = (db, env, component) =>
  all(
    db,
    "SELECT * FROM observations WHERE environment = ? AND component = ? ORDER BY slot DESC LIMIT 2",
    env,
    component,
  );
export async function current(db, environments, notes, now) {
  const output = {};
  for (const [environment, config] of Object.entries(environments)) {
    const open = await all(
      db,
      "SELECT component FROM incidents WHERE environment = ? AND resolved_at IS NULL",
      environment,
    );
    const components = [];
    for (const [id, c] of Object.entries(COMPONENTS)) {
      const rows = await recent(db, environment, id);
      let state = componentState(rows, now, c.cadence, config.launched);
      if (state === "operational" && open.some((i) => i.component === id))
        state = "degraded";
      if (
        config.launched &&
        notes.some(
          (n) =>
            n.kind === "maintenance" &&
            n.environment === environment &&
            n.components.includes(id) &&
            n.startsAt <= now &&
            (n.endsAt === null || n.endsAt > now),
        )
      )
        state = "maintenance";
      components.push({
        id,
        label: c.label,
        cadence: c.cadence,
        state,
        lastCheckedAt: rows[0]?.observed_at ?? null,
        outcome: rows[0]?.outcome ?? null,
        reason: rows[0]?.reason ?? null,
      });
    }
    const activity =
      (
        await all(
          db,
          "SELECT sampled_at AS sampledAt,state,sessions,players FROM activity WHERE environment = ? ORDER BY sampled_at DESC LIMIT 1",
          environment,
        )
      )[0] ?? null;
    output[environment] = {
      label: config.label,
      launched: config.launched,
      components,
      activity:
        config.launched && activity && now - activity.sampledAt < 1800
          ? activity
          : {
              state: "unavailable",
              sessions: null,
              players: null,
              sampledAt: activity?.sampledAt ?? null,
            },
    };
  }
  return {
    schema: "topiaforge.public-status/1",
    generatedAt: now,
    environments: output,
  };
}
export async function history(db, environment, seconds, now) {
  // Archived counts describe complete UTC days. Clip the 90-day calendar view
  // at a day boundary rather than counting data from outside its stated range.
  const start =
    seconds > 30 * DAY ? Math.ceil((now - seconds) / DAY) * DAY : now - seconds;
  const components = {};
  for (const [id, c] of Object.entries(COMPONENTS)) {
    const [raw, archived, monitor] = await db.batch([
      db
        .prepare(
          "SELECT * FROM observations WHERE environment = ? AND component = ? AND slot >= ? AND observed_at <= ? ORDER BY slot",
        )
        .bind(environment, id, Math.floor(start / c.cadence) * c.cadence, now),
      db
        .prepare(
          "SELECT * FROM daily WHERE environment = ? AND component = ? AND day >= ? AND day < ? ORDER BY day",
        )
        .bind(
          environment,
          id,
          Math.floor(start / DAY) * DAY,
          Math.floor((now - 30 * DAY) / DAY) * DAY,
        ),
      db
        .prepare(
          "SELECT started_at FROM monitor_start WHERE environment = ? AND component = ?",
        )
        .bind(environment, id),
    ]);
    // Read details and archives in one snapshot: midnight retention must not
    // make an observation disappear from, or appear twice in, the same result.
    const rows = raw.results,
      days = archived.results,
      began = monitor.results[0]?.started_at;
    components[id] = {
      startedAt: began ?? null,
      ...summary(
        rows,
        days,
        now,
        began == null ? null : Math.max(start, began),
        c.cadence,
        Math.max(start, now - 30 * DAY),
      ),
      points: rows.map((r) => ({
        at: r.slot,
        outcome: r.outcome,
        latencyMs: r.outcome === "pass" ? r.latency_ms : null,
      })),
      daily: days.map((d) => ({
        at: d.day,
        passed: d.passed,
        failed: d.failed,
        blocked: d.blocked,
      })),
    };
  }
  return {
    environment,
    from: start,
    to: now,
    components,
    activity: await all(
      db,
      "SELECT sampled_at AS sampledAt,state,sessions,players FROM activity WHERE environment = ? AND sampled_at >= ? ORDER BY sampled_at",
      environment,
      start,
    ),
    latencyWindowDays: 30,
  };
}
export async function incidents(db, notes, now) {
  return {
    automatic: await all(
      db,
      `SELECT id,environment,component,started_at AS startedAt,confirmed_at AS confirmedAt,resolved_at AS resolvedAt
       FROM incidents WHERE resolved_at IS NULL OR id IN (
         SELECT id FROM incidents WHERE resolved_at IS NOT NULL ORDER BY started_at DESC LIMIT 200
       ) ORDER BY started_at DESC`,
    ),
    notes,
    generatedAt: now,
  };
}
export async function retain(db, now) {
  // Daily rows are rebuilt until the entire UTC day is older than the detailed retention window.
  const cutoff = Math.floor((now - 30 * DAY) / DAY) * DAY;
  await db.batch([
    db
      .prepare(
        `INSERT INTO daily SELECT environment,component,CAST(slot / 86400 AS INTEGER)*86400,
      SUM(outcome='pass'),SUM(outcome='fail'),SUM(outcome='blocked') FROM observations WHERE slot < ?
      GROUP BY environment,component,CAST(slot / 86400 AS INTEGER)
      ON CONFLICT(environment,component,day) DO UPDATE SET passed=excluded.passed,failed=excluded.failed,blocked=excluded.blocked`,
      )
      .bind(cutoff),
    db.prepare("DELETE FROM observations WHERE slot < ?").bind(cutoff),
    db.prepare("DELETE FROM daily WHERE day < ?").bind(now - 90 * DAY),
    db
      .prepare("DELETE FROM activity WHERE sampled_at < ?")
      .bind(now - 90 * DAY),
    db
      .prepare(
        "DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?",
      )
      .bind(now - 90 * DAY),
    db.prepare("DELETE FROM claims WHERE slot < ?").bind(now - 86400),
  ]);
}
