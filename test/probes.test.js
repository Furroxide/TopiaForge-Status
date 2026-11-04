import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
  basic,
  full,
  identity,
  client,
  stage,
  ProbeFailure,
  validateStatus,
  openSignal,
} from "../scripts/probes.mjs";

test("malformed signaling frames fail a pending probe without crashing its process", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const peerReady = once(server, "connection");
  const session = await openSignal(
    `http://127.0.0.1:${server.address().port}`,
    "/signal",
    "test-only-token",
  );
  const [peer] = await peerReady;
  try {
    const waiting = session.next((frame) => frame.type === "welcome");
    peer.send("null");
    await assert.rejects(waiting);
  } finally {
    session.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
const config = {
  origin: "https://mp-staging.topiaforge.dev",
  build: "2545",
  protocol: "1",
};
const flags = {
  schema: "topiaforge.control-plane-status/1",
  api: 1,
  killSwitch: false,
  features: { hosting: true, invites: true, signaling: true, relay: true },
};
const host = identity(
  crypto
    .generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" }),
);

test("a signaling server that welcomes clients but drops their frames cannot pass", async () => {
  const api = async (method, path) => {
    if (path === "/v1/status") return { status: 200, value: flags };
    if (path.endsWith("/challenge"))
      return { status: 200, value: { challenge: "test-challenge" } };
    if (path === "/v1/hosts")
      return {
        status: 201,
        value: {
          serverId: host.serverId,
          sessionToken: "test-token",
          listed: false,
          invite: { code: "test-invite" },
        },
      };
    if (path.endsWith("/heartbeat")) return { status: 200, value: {} };
    if (path.startsWith("/v1/servers"))
      return { status: 200, value: { servers: [], next: null } };
    if (path === "/v1/invites/resolve")
      return { status: 200, value: { serverId: host.serverId } };
    if (path === "/v1/join-tickets")
      return { status: 201, value: { ticket: "test-ticket" } };
    if (path === "/v1/turn/credentials") return { status: 201, value: {} };
    if (method === "DELETE") return { status: 204, value: null };
    throw new Error("unexpected request");
  };
  let count = 0;
  const rows = await full(api, config, host, {
    sleep: async () => {},
    relayCheck: async () => {},
    socketFactory: async () => {
      const peer = count++ === 1,
        frames = peer
          ? [{ type: "welcome", role: "peer", hostOnline: true }]
          : [{ type: "welcome" }, { type: "joined" }];
      return {
        socket: { send() {} },
        close() {},
        async next(match) {
          const frame = frames.find(match);
          if (!frame) throw new ProbeFailure("timeout");
          return frame;
        },
      };
    },
  });
  assert.equal(rows.find((r) => r.component === "signaling").outcome, "fail");
});
test("basic probe rejects malformed status, feature shapes and browser responses", async () => {
  assert.throws(() =>
    validateStatus({ ...flags, features: { hosting: true } }),
  );
  for (const reply of [
    { status: 200, value: {} },
    { status: 503, value: flags },
  ])
    assert.equal((await basic(async () => reply, config))[0].outcome, "fail");
  assert.equal(
    (
      await basic(
        async (_m, path) =>
          path === "/v1/status"
            ? { status: 200, value: flags }
            : { status: 200, value: { servers: [], next: null } },
        config,
      )
    )[0].outcome,
    "pass",
  );
});
test("timeouts and unexpected failures expose fixed reasons, never error text", async () => {
  const api = client(config.origin, {
    fetchImpl: async () => {
      throw new DOMException("sensitive host", "TimeoutError");
    },
  });
  const result = await stage("api", () => api("GET", "/v1/status"));
  assert.equal(result.reason, "timeout");
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  assert.equal(
    (
      await stage("api", () => {
        throw new ProbeFailure("disabled");
      })
    ).reason,
    "disabled",
  );
});
test("dependency failures are blocked and known disabled hosting fails without registering", async () => {
  const rows = await full(
    async () => ({ status: 500, value: null }),
    config,
    host,
  );
  assert.ok(rows.every((r) => r.outcome === "blocked"));
  const disabled = await full(
    async () => ({
      status: 200,
      value: { ...flags, features: { ...flags.features, hosting: false } },
    }),
    config,
    host,
  );
  assert.equal(disabled[0].reason, "disabled");
  assert.ok(disabled.slice(1).every((r) => r.outcome === "blocked"));
});
test("a failed signaling stage still closes owned sockets, probes relay and cleans the host", async () => {
  let mints = 0,
    ended = 0,
    closed = 0;
  const api = async (method, path) => {
    if (path === "/v1/status") return { status: 200, value: flags };
    if (path.endsWith("/challenge"))
      return { status: 200, value: { challenge: "challenge" } };
    if (path === "/v1/hosts")
      return {
        status: 201,
        value: {
          serverId: host.serverId,
          sessionToken: "private token",
          listed: false,
          invite: { code: "private invite" },
        },
      };
    if (path.endsWith("/heartbeat")) return { status: 200, value: {} };
    if (path.startsWith("/v1/servers"))
      return { status: 200, value: { servers: [], next: null } };
    if (path === "/v1/invites/resolve")
      return { status: 200, value: { serverId: host.serverId } };
    if (path === "/v1/join-tickets")
      return { status: 201, value: { ticket: "private ticket" } };
    if (path === "/v1/turn/credentials") {
      mints++;
      return { status: 201, value: {} };
    }
    if (method === "DELETE") {
      ended++;
      return { status: 204, value: null };
    }
    throw new Error("unexpected request");
  };
  const rows = await full(api, config, host, {
    sleep: async () => {},
    socketFactory: async () => ({
      next: async () => {
        throw new ProbeFailure("timeout");
      },
      close: () => closed++,
    }),
    relayCheck: async () => {},
  });
  assert.equal(rows.find((r) => r.component === "signaling").reason, "timeout");
  assert.equal(rows.find((r) => r.component === "relay").outcome, "pass");
  assert.equal(mints, 2);
  assert.equal(ended, 1);
  assert.equal(closed, 1);
  assert.doesNotMatch(
    JSON.stringify(rows),
    /private token|private ticket|private invite/,
  );
});
test("client refuses unbounded response bodies and classifies throttling", async () => {
  const api = client(config.origin, {
    fetchImpl: async () => new Response("x".repeat(300000)),
  });
  assert.equal(
    (await stage("api", () => api("GET", "/v1/status"))).reason,
    "invalid-response",
  );
  const throttled = client(config.origin, {
    fetchImpl: async () => new Response("", { status: 429 }),
  });
  assert.equal(
    (await stage("api", () => throttled("GET", "/v1/status"))).reason,
    "rate-limited",
  );
});
