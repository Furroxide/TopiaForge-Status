import environments from "../config/environments.json" with { type: "json" };
import notes from "../config/incidents.json" with { type: "json" };
import {
  MONITOR_MODES,
  RANGES,
  slotAt,
  validObservationTime,
  validRunId,
  validateNotes,
  validateObservation,
} from "./domain.js";
import {
  claimRun,
  current,
  history,
  incidents,
  ingest,
  ownsClaim,
  retain,
} from "./store.js";
validateNotes(notes, environments);
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers });

async function publicHistory(url, db, environment, range, now, ctx) {
  // Canonical public keys keep query ordering and arbitrary headers out of the cache.
  const key = new URL("/api/history", url);
  key.searchParams.set("environment", environment);
  key.searchParams.set("range", range);
  const cache =
    ctx &&
    (await globalThis.caches?.open("status-history-public-v3").catch(() => undefined));
  const saved = await cache?.match(key.href).catch(() => undefined);
  if (saved) return new Response(saved.body, { headers });

  const response = json(await history(db, environment, RANGES[range], now));
  if (cache) {
    const copy = response.clone();
    copy.headers.set(
      "cache-control",
      `public, max-age=${range === "24h" ? 60 : 300}`,
    );
    ctx.waitUntil(cache.put(key.href, copy).catch(() => {}));
  }
  return response;
}
export async function authorized(request, token) {
  if (typeof token !== "string" || token.length < 32) return false;
  const actual = request.headers.get("authorization") ?? "";
  const hash = (x) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(x));
  const [a, b] = await Promise.all([hash(actual), hash(`Bearer ${token}`)]);
  const aa = new Uint8Array(a),
    bb = new Uint8Array(b);
  let different = 0;
  for (let i = 0; i < aa.length; i++) different |= aa[i] ^ bb[i];
  return different === 0;
}
async function body(request) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new Error("media type");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16384) throw new Error("size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url),
      now = Math.floor(Date.now() / 1000);
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/internal/")
    ) {
      const response = await env.ASSETS.fetch(request);
      const secured = new Response(response.body, response);
      secured.headers.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      secured.headers.set("referrer-policy", "no-referrer");
      secured.headers.set("x-content-type-options", "nosniff");
      return secured;
    }
    try {
      if (
        url.pathname === "/internal/claim" ||
        url.pathname === "/internal/run-claim"
      ) {
        if (!(await authorized(request, env.INGEST_TOKEN)))
          return json({ error: "unauthorized" }, 401);
        if (request.method !== "POST")
          return json({ error: "method-not-allowed" }, 405);
        let claim;
        try {
          claim = await body(request);
        } catch {
          return json({ error: "invalid-request" }, 400);
        }
        if (
          typeof claim?.environment !== "string" ||
          !Object.hasOwn(environments, claim.environment) ||
          !environments[claim.environment].launched ||
          typeof claim.mode !== "string" ||
          !Object.hasOwn(MONITOR_MODES, claim.mode)
        )
          return json({ error: "invalid-request" }, 400);
        const { cadence } = MONITOR_MODES[claim.mode];
        if (url.pathname === "/internal/run-claim") {
          if (
            !validRunId(claim.runId) ||
            !validObservationTime(claim.observedAt, now, 60)
          )
            return json({ error: "invalid-request" }, 400);
          const slot = slotAt(claim.observedAt, cadence);
          const acquired = await claimRun(env.DB, { ...claim, slot }, now);
          return json({ acquired, slot });
        }
        const slot = slotAt(now, cadence);
        const acquired = await claimRun(
          env.DB,
          {
            environment: claim.environment,
            mode: claim.mode,
            slot,
            observedAt: now,
          },
          now,
        );
        return json({ acquired });
      }
      if (url.pathname === "/internal/observations") {
        if (!(await authorized(request, env.INGEST_TOKEN)))
          return json({ error: "unauthorized" }, 401);
        if (request.method !== "POST")
          return json({ error: "method-not-allowed" }, 405);
        let value;
        try {
          value = validateObservation(await body(request), now, environments);
        } catch {
          return json({ error: "invalid-request" }, 400);
        }
        if (value.mode && !(await ownsClaim(env.DB, value)))
          return json({ error: "claim-mismatch" }, 409);
        await ingest(env.DB, value);
        return json({ accepted: true });
      }
      if (request.method !== "GET")
        return json({ error: "method-not-allowed" }, 405);
      if (url.pathname === "/api/status" && !url.search)
        return json(await current(env.DB, environments, notes, now));
      if (url.pathname === "/api/incidents" && !url.search)
        return json(await incidents(env.DB, notes, now));
      if (url.pathname === "/api/history") {
        if (
          [...url.searchParams.keys()].some(
            (k) => !["environment", "range"].includes(k),
          ) ||
          url.searchParams.size !== 2
        )
          return json({ error: "invalid-request" }, 400);
        const environment = url.searchParams.get("environment"),
          range = url.searchParams.get("range");
        if (
          !Object.hasOwn(environments, environment) ||
          !Object.hasOwn(RANGES, range)
        )
          return json({ error: "invalid-request" }, 400);
        return await publicHistory(url, env.DB, environment, range, now, ctx);
      }
      return json({ error: "not-found" }, 404);
    } catch {
      return json({ error: "temporarily-unavailable" }, 503);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(retain(env.DB, Math.floor(controller.scheduledTime / 1000)));
  },
};
