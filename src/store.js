import { publicActivity, ACTIVITY_SCHEMA } from "../public/activity.js";
import {
  COMPONENTS,
  MONITOR_MODES,
  componentState,
  slotAt,
  summary,
} from "./domain.js";
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
    const slot = value.slot ?? slotAt(value.observedAt, cadence);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO observations SELECT ?,?,?,?,?,?,?,?
          WHERE ? IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM claim_owners WHERE environment = ? AND mode = ? AND slot = ? AND run_id <> ''
          )`,
        )
        .bind(
          value.environment,
          c.component,
          slot,
          value.observedAt,
          c.outcome,
          c.latencyMs,
          c.reason,
          value.runId,
          value.mode ?? null,
          value.environment,
          c.component === "api" ? "basic" : "full",
          slot,
        ),
      db
        .prepare(
          `INSERT INTO monitor_start
          SELECT environment, component, observed_at FROM observations
          WHERE environment = ? AND component = ? AND slot = ?
          ON CONFLICT(environment,component) DO UPDATE SET started_at = MIN(started_at, excluded.started_at)`,
        )
        .bind(value.environment, c.component, slot),
      db
        .prepare(
          `WITH newest AS (
        SELECT * FROM observations WHERE environment = ? AND component = ? ORDER BY slot DESC LIMIT 2
      ) INSERT OR IGNORE INTO incidents
        SELECT a.environment || '-' || a.component || '-' || b.slot,a.environment,a.component,b.observed_at,a.observed_at,NULL
        FROM newest a JOIN newest b ON a.slot = b.slot + ?
        WHERE (a.slot = ? OR b.slot = ?) AND a.outcome = 'fail' AND b.outcome = 'fail'`,
        )
        .bind(value.environment, c.component, cadence, slot, slot),
      db
        .prepare(
          `WITH newest AS (
        SELECT * FROM observations WHERE environment = ? AND component = ? ORDER BY slot DESC LIMIT 2
      ), recovery AS (
        SELECT a.observed_at AS at FROM newest a JOIN newest b ON a.slot = b.slot + ?
        WHERE (a.slot = ? OR b.slot = ?) AND a.outcome = 'pass' AND b.outcome = 'pass'
      ) UPDATE incidents SET resolved_at = (SELECT at FROM recovery)
        WHERE environment = ? AND component = ? AND resolved_at IS NULL
        AND confirmed_at < (SELECT at FROM recovery)`,
        )
        .bind(
          value.environment,
          c.component,
          cadence,
          slot,
          slot,
          value.environment,
          c.component,
        ),
    );
  }
  const a = publicActivity(value.activity);
  if (a) {
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO public_activity_v2 VALUES (?,?,?,?,?)")
        .bind(value.environment, a.sampledAt, a.state, a.sessionsBand?.min ?? null, a.playersBand?.min ?? null),
    );
  }
  const full = MONITOR_MODES.full;
  if (
    value.mode === "full" ||
    (!value.mode &&
      full.components.every((id) =>
        value.components.some((component) => component.component === id),
      ))
  ) {
    statements.push(
      db
        .prepare(
          `UPDATE claim_owners SET lease_until = 0
      WHERE environment = ? AND mode = 'full' AND slot = ? AND run_id = ?`,
        )
        .bind(
          value.environment,
          value.slot ?? slotAt(value.observedAt, full.cadence),
          value.mode ? value.runId : "",
        ),
    );
  }
  // D1 batch commits observations and incident transitions together. Retrying a
  // failed delivery cannot leave its incident permanently missing or unresolved.
  await db.batch(statements);
}
export async function claimRun(
  db,
  { environment, mode, slot, observedAt, runId },
  now,
) {
  // Both runner versions reserve the same slot. The extra row lets the newer
  // runner retry a request whose commit succeeded but whose response was lost.
  const components = MONITOR_MODES[mode].components;
  const leaseSeconds = 240;
  const [inserted, , owner] = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO claim_owners
      SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM claims WHERE environment = ? AND mode = ? AND slot = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM observations WHERE environment = ? AND slot = ?
        AND component IN (${components.map(() => "?").join(",")})
      ) AND (? <> 'full' OR NOT EXISTS (
        SELECT 1 FROM claim_owners
        WHERE environment = ? AND mode = 'full' AND slot >= ? AND lease_until > ?
      )
      )`,
      )
      .bind(
        environment,
        mode,
        slot,
        observedAt,
        runId ?? "",
        mode === "full" ? now + leaseSeconds : 0,
        environment,
        mode,
        slot,
        environment,
        slot,
        ...components,
        mode,
        environment,
        slotAt(now - leaseSeconds - 30, MONITOR_MODES.full.cadence),
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO claims
        SELECT environment, mode, slot FROM claim_owners WHERE environment = ? AND mode = ? AND slot = ?`,
      )
      .bind(environment, mode, slot),
    db
      .prepare(
        `SELECT run_id, observed_at FROM claim_owners
        WHERE environment = ? AND mode = ? AND slot = ? AND NOT EXISTS (
          SELECT 1 FROM observations WHERE environment = ? AND component = ? AND slot = ?
        )`,
      )
      .bind(environment, mode, slot, environment, components[0], slot),
  ]);
  if (runId === undefined) return inserted.meta.changes === 1;
  const row = owner.results[0];
  return row?.run_id === runId && row.observed_at === observedAt;
}
export async function ownsClaim(
  db,
  { environment, mode, slot, observedAt, runId },
) {
  const rows = await all(
    db,
    "SELECT 1 FROM claim_owners WHERE environment = ? AND mode = ? AND slot = ? AND observed_at = ? AND run_id = ?",
    environment,
    mode,
    slot,
    observedAt,
    runId,
  );
  return rows.length > 0;
}
export async function current(db, environments, notes, now) {
  const output = {};
  for (const [environment, config] of Object.entries(environments)) {
    const entries = Object.entries(COMPONENTS);
    const [open, samples, ...checks] = await db.batch([
      db
        .prepare(
          `SELECT component FROM incidents WHERE environment = ? AND resolved_at IS NULL AND confirmed_at <= ?
          UNION ALL
          SELECT component FROM incidents WHERE environment = ? AND resolved_at > ? AND confirmed_at <= ?`,
        )
        .bind(environment, now, environment, now, now),
      db
        .prepare(
          "SELECT sampled_at AS sampledAt,state,sessions,players FROM public_activity_v2 WHERE environment = ? AND sampled_at <= ? ORDER BY sampled_at DESC LIMIT 1",
        )
        .bind(environment, now - 900),
      ...entries.map(([id]) =>
        db
          .prepare(
            "SELECT slot, observed_at, outcome, reason FROM observations WHERE environment = ? AND component = ? AND observed_at <= ? ORDER BY slot DESC LIMIT 2",
          )
          .bind(environment, id, now),
      ),
    ]);
    const components = entries.map(([id, c], index) => {
      const rows = checks[index].results;
      let state = componentState(rows, now, c.cadence, config.launched);
      if (
        state === "operational" &&
        open.results.some((i) => i.component === id)
      )
        state = "degraded";
      const measurementState = state;
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
      return {
        id,
        label: c.label,
        cadence: c.cadence,
        state,
        measurementState,
        lastCheckedAt: rows[0]?.observed_at ?? null,
        outcome: rows[0]?.outcome ?? null,
        reason: rows[0]?.reason ?? null,
      };
    });
    const activity = storedActivity(samples.results[0]);
    output[environment] = {
      label: config.label,
      launched: config.launched,
      components,
      activity:
        config.launched && activity && now - activity.sampledAt < 1800
          ? activity
          : {
              schema: ACTIVITY_SCHEMA,
              scope: "public",
              state: "unavailable",
              sessionsBand: null,
              playersBand: null,
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
    const windowSlot = slotAt(start, c.cadence);
    const [raw, archived, monitor] = await db.batch([
      db
        .prepare(
          "SELECT slot, observed_at, outcome, latency_ms FROM observations WHERE environment = ? AND component = ? AND slot >= ? AND observed_at BETWEEN ? AND ? ORDER BY slot",
        )
        .bind(environment, id, windowSlot, start, now),
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
    const firstInWindow =
      start === windowSlot || rows[0]?.slot === windowSlot
        ? windowSlot
        : windowSlot + c.cadence;
    components[id] = {
      startedAt: began ?? null,
      ...summary(
        rows,
        days,
        now,
        began == null
          ? null
          : Math.max(firstInWindow, slotAt(began, c.cadence)),
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
    activity: (await all(
      db,
      "SELECT sampled_at AS sampledAt,state,sessions,players FROM public_activity_v2 WHERE environment = ? AND sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at",
      environment,
      start,
      now - 900,
    )).map(storedActivity).filter(Boolean),
    latencyWindowDays: 30,
  };
}
export async function incidents(db, notes, now) {
  return {
    automatic: await all(
      db,
      `SELECT id,environment,component,started_at AS startedAt,confirmed_at AS confirmedAt,
         CASE WHEN resolved_at <= ? THEN resolved_at END AS resolvedAt
       FROM incidents WHERE confirmed_at <= ? AND (resolved_at IS NULL OR resolved_at > ? OR id IN (
         SELECT id FROM incidents WHERE resolved_at <= ? ORDER BY started_at DESC LIMIT 200
       )) ORDER BY started_at DESC`,
      now,
      now,
      now,
      now,
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
      .prepare("DELETE FROM public_activity_v2 WHERE sampled_at < ?")
      .bind(now - 90 * DAY),
    db
      .prepare(
        "DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?",
      )
      .bind(now - 90 * DAY),
    db.prepare("DELETE FROM claims WHERE slot < ?").bind(now - 86400),
    db.prepare("DELETE FROM claim_owners WHERE slot < ?").bind(now - 86400),
  ]);
}

function storedActivity(row) {
  if (!row) return null;
  return publicActivity({
    schema: ACTIVITY_SCHEMA, scope: "public", sampledAt: row.sampledAt, state: row.state,
    sessionsBand: row.sessions === null ? null : { min: row.sessions, max: row.sessions + 4 },
    playersBand: row.players === null ? null : { min: row.players, max: row.players + 9 },
  });
}
