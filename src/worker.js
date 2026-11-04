import environments from "../config/environments.json" with { type: "json" };
import notes from "../config/incidents.json" with { type: "json" };
import { RANGES, validateNotes, validateObservation } from "./domain.js";
import { current, history, incidents, ingest, retain } from "./store.js";
validateNotes(notes, environments);
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers });
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
  if (!request.headers.get("content-type")?.startsWith("application/json"))
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
  return JSON.parse(new TextDecoder().decode(bytes));
}
export default {
  async fetch(request, env) {
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
      if (url.pathname === "/internal/claim") {
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
          !environments[claim?.environment]?.launched ||
          !["basic", "full"].includes(claim.mode)
        )
          return json({ error: "invalid-request" }, 400);
        const cadence = claim.mode === "full" ? 600 : 300,
          slot = Math.floor(now / cadence) * cadence;
        const result = await env.DB.prepare(
          "INSERT OR IGNORE INTO claims VALUES (?,?,?)",
        )
          .bind(claim.environment, claim.mode, slot)
          .run();
        return json({ acquired: result.meta.changes === 1 });
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
        return json(await history(env.DB, environment, RANGES[range], now));
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
