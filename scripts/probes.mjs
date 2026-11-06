import crypto from "node:crypto";
import dns from "node:dns/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import WebSocket from "ws";
import { TurnAllocation } from "./turn-probe.mjs";
export const canonical = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(",")}}`;
export class ProbeFailure extends Error {
  constructor(reason, outcome = "fail") {
    super(reason);
    this.reason = reason;
    this.outcome = outcome;
  }
}
const check = (condition, reason = "invalid-response") => {
  if (!condition) throw new ProbeFailure(reason);
};
export function identity(pem) {
  const signing = crypto.createPrivateKey(pem),
    publicKey = crypto.createPublicKey(signing).export({ format: "jwk" });
  check(publicKey.crv === "Ed25519", "probe-error");
  const signingKey = publicKey.x,
    serverId = crypto
      .createHash("sha256")
      .update(Buffer.from(signingKey, "base64url"))
      .digest("hex");
  return {
    signing,
    signingKey,
    serverId,
    transportKey: crypto
      .generateKeyPairSync("x25519")
      .publicKey.export({ format: "jwk" }).x,
  };
}
export function descriptor(host, config, now) {
  const packages = [];
  const value = {
    schema: "topiaforge.server-descriptor/1",
    serverId: host.serverId,
    signingKey: host.signingKey,
    transportKey: host.transportKey,
    issuedAt: now,
    name: "TopiaForge connection monitor",
    gameBuild: config.build,
    runtimeVersion: "0.2.0",
    protocolVersion: `${config.protocol}.0.0`,
    maxPlayers: 4,
    passwordRequired: false,
    voice: false,
    visibility: "invite",
    hostServesPackages: false,
    gamemode: "Open Sandbox",
    world: null,
    packages,
    packageDigest: crypto
      .createHash("sha256")
      .update(canonical(packages))
      .digest("hex"),
  };
  return canonical({
    descriptor: value,
    signature: crypto
      .sign(
        null,
        Buffer.from(`TopiaForge server descriptor v1\n${canonical(value)}`),
        host.signing,
      )
      .toString("base64url"),
  });
}
export function client(
  origin,
  { fetchImpl = fetch, signal = AbortSignal.timeout(90000) } = {},
) {
  return async (method, path, { token, body } = {}) => {
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method,
        redirect: "manual",
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : canonical(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (response.status === 429) throw new ProbeFailure("rate-limited");
      const reader = response.body?.getReader();
      let bytes = 0,
        text = "";
      const decoder = new TextDecoder();
      try {
        if (reader)
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 262144) throw new ProbeFailure("invalid-response");
            text += decoder.decode(value, { stream: true });
          }
        text += decoder.decode();
      } finally {
        await reader?.cancel().catch(() => {});
      }
      let value = null;
      try {
        value = text ? JSON.parse(text) : null;
      } catch {
        throw new ProbeFailure("invalid-response");
      }
      return { status: response.status, value };
    } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure(
        error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "timeout"
          : "http-error",
      );
    }
  };
}
export async function stage(component, work) {
  const started = performance.now();
  try {
    const reason = await work();
    return {
      component,
      outcome: "pass",
      reason: typeof reason === "string" ? reason : "ok",
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      component,
      outcome: error instanceof ProbeFailure ? error.outcome : "fail",
      reason: error instanceof ProbeFailure ? error.reason : "probe-error",
      latencyMs: null,
    };
  }
}
export const blocked = (component) => ({
  component,
  outcome: "blocked",
  reason: "dependency",
  latencyMs: null,
});
export function validateStatus(value) {
  check(
    value?.schema === "topiaforge.control-plane-status/1" &&
      value.api === 1 &&
      typeof value.killSwitch === "boolean" &&
      ["hosting", "invites", "signaling", "relay"].every(
        (k) => typeof value.features?.[k] === "boolean",
      ),
  );
  return value;
}
async function browse(api, config) {
  const response = await api(
    "GET",
    `/v1/servers?build=${config.build}&protocol=${config.protocol}&limit=1`,
  );
  check(response.status === 200, "http-error");
  const { servers, next } = response.value ?? {};
  check(
    Array.isArray(servers) &&
      servers.length <= 1 &&
      servers.every(
        (entry) =>
          typeof entry?.serverId === "string" &&
          /^[0-9a-f]{64}$/.test(entry.serverId),
      ) &&
      (next === null ||
        (typeof next === "string" && next === servers[0]?.serverId)),
  );
  return servers;
}
export async function basic(api, config) {
  return [
    await stage("api", async () => {
      const s = await api("GET", "/v1/status");
      check(s.status === 200, "http-error");
      validateStatus(s.value);
      await browse(api, config);
    }),
  ];
}
export async function openSignal(origin, path, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${origin.replace("https:", "wss:").replace("http:", "ws:")}${path}`,
      {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: 8000,
        maxPayload: 32768,
      },
    );
    const frames = [],
      waiters = new Set();
    let open = false,
      failure = null;
    const fail = (reason = "http-error") => {
      if (failure) return;
      failure = new ProbeFailure(reason);
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(failure);
      }
      waiters.clear();
      if (!open) reject(failure);
    };
    const malformed = () => {
      fail("invalid-response");
      socket.terminate();
    };
    socket.on("error", () => fail());
    socket.on("close", () => fail());
    socket.on("unexpected-response", () => {
      fail();
      socket.terminate();
    });
    socket.on("message", (data) => {
      let value;
      try {
        value = JSON.parse(data.toString());
      } catch {
        malformed();
        return;
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.type !== "string" ||
        frames.length >= 64
      ) {
        malformed();
        return;
      }
      frames.push(value);
      for (const w of waiters) {
        let matches;
        try {
          matches = w.match(value);
        } catch {
          malformed();
          return;
        }
        if (matches) {
          clearTimeout(w.timer);
          waiters.delete(w);
          w.resolve(value);
        }
      }
    });
    socket.on("open", () => {
      open = true;
      resolve({
        socket,
        next: (match) =>
          new Promise((resolve, reject) => {
            if (failure) return reject(failure);
            const found = frames.find(match);
            if (found) return resolve(found);
            const waiter = {
              match,
              resolve,
              reject,
              timer: setTimeout(() => {
                waiters.delete(waiter);
                reject(new ProbeFailure("timeout"));
              }, 8000),
            };
            waiters.add(waiter);
          }),
        close: () => {
          fail();
          socket.terminate();
        },
      });
    });
  });
}
export async function full(
  api,
  config,
  host,
  {
    socketFactory = openSignal,
    relayCheck = relay,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const results = [];
  let token, invite, ticket;
  const sockets = [];
  let status;
  try {
    const s = await api("GET", "/v1/status");
    check(s.status === 200, "http-error");
    status = validateStatus(s.value);
  } catch {
    return ["discovery", "invites", "signaling", "relay"].map(blocked);
  }
  try {
    results.push(
      await stage("discovery", async () => {
        check(status.features.hosting, "disabled");
        const challenge = await api("POST", "/v1/hosts/challenge", {
          body: { signingKey: host.signingKey },
        });
        check(
          challenge.status === 200 &&
            typeof challenge.value?.challenge === "string",
        );
        const unsigned = {
          challenge: challenge.value.challenge,
          descriptor: descriptor(host, config, Math.floor(Date.now() / 1000)),
          relayOnly: true,
        };
        const proof = crypto
          .sign(
            null,
            Buffer.from(
              `TopiaForge host registration v1\n${canonical(unsigned)}`,
            ),
            host.signing,
          )
          .toString("base64url");
        const registered = await api("POST", "/v1/hosts", {
          body: { ...unsigned, proof },
        });
        if (
          registered.status === 201 &&
          typeof registered.value?.sessionToken === "string"
        )
          token = registered.value.sessionToken;
        check(
          registered.status === 201 &&
            registered.value?.serverId === host.serverId &&
            typeof token === "string" &&
            registered.value.listed === false &&
            typeof registered.value.invite?.code === "string",
        );
        invite = registered.value.invite.code;
        await sleep(5100);
        const beat = await api("POST", `/v1/hosts/${host.serverId}/heartbeat`, {
          token,
          body: { players: 0 },
        });
        check(beat.status === 200, "http-error");
        const servers = await browse(api, config);
        check(!servers.some((s) => s.serverId === host.serverId));
        const detail = await api("GET", `/v1/servers/${host.serverId}`);
        check(
          detail.status === 404 && detail.value?.error?.code === "not-found",
        );
      }),
    );
    if (!token || !invite)
      return [...results, ...["invites", "signaling", "relay"].map(blocked)];
    results.push(
      await stage("invites", async () => {
        check(status.features.invites, "disabled");
        const resolved = await api("POST", "/v1/invites/resolve", {
          body: { code: invite },
        });
        check(
          resolved.status === 200 && resolved.value?.serverId === host.serverId,
        );
        const joined = await api("POST", "/v1/join-tickets", {
          body: { invite, relayOnly: true, serverId: host.serverId },
        });
        check(
          joined.status === 201 && typeof joined.value?.ticket === "string",
        );
        ticket = joined.value.ticket;
      }),
    );
    results.push(
      ticket
        ? await stage("signaling", async () => {
            check(status.features.signaling, "disabled");
            const a = await socketFactory(
              config.origin,
              `/v1/signal/${host.serverId}`,
              token,
            );
            sockets.push(a);
            const hosting = await a.next((f) => f.type === "welcome");
            check(hosting.role === "host");
            const b = await socketFactory(
              config.origin,
              `/v1/signal/${host.serverId}`,
              ticket,
            );
            sockets.push(b);
            const welcome = await b.next((f) => f.type === "welcome");
            check(
              welcome.hostOnline === true &&
                welcome.hostRelayOnly === true &&
                welcome.role === "peer" &&
                typeof welcome.peer === "string",
            );
            const joined = await a.next((f) => f.type === "joined");
            check(joined.peer === welcome.peer && joined.relayOnly === true);
            const peerIce = {
              ufrag: crypto.randomBytes(4).toString("hex"),
              pwd: crypto.randomBytes(16).toString("hex"),
            };
            b.socket.send(
              canonical({ type: "offer", ice: peerIce, candidates: [] }),
            );
            const offer = await a.next((f) => f.type === "offer");
            check(
              offer.peer === joined.peer &&
                offer.ice?.ufrag === peerIce.ufrag &&
                offer.ice?.pwd === peerIce.pwd &&
                Array.isArray(offer.candidates) &&
                offer.candidates.length === 0,
            );
            const hostIce = {
              ufrag: crypto.randomBytes(4).toString("hex"),
              pwd: crypto.randomBytes(16).toString("hex"),
            };
            a.socket.send(
              canonical({
                type: "answer",
                peer: offer.peer,
                ice: hostIce,
                candidates: [],
              }),
            );
            const answer = await b.next((f) => f.type === "answer");
            check(
              answer.ice?.ufrag === hostIce.ufrag &&
                answer.ice?.pwd === hostIce.pwd &&
                Array.isArray(answer.candidates) &&
                answer.candidates.length === 0,
            );
          })
        : blocked("signaling"),
    );
    results.push(
      ticket
        ? await stage("relay", async () => {
            check(status.features.relay && !status.killSwitch, "disabled");
            const [a, b] = await relayStep("relay-credentials", async () => {
              const values = [];
              for (const credential of [token, ticket]) {
                const response = await api("POST", "/v1/turn/credentials", {
                  token: credential,
                  body: { serverId: host.serverId },
                });
                check(response.status === 201);
                values.push(response.value);
              }
              return values;
            });
            const attempts = await relayCheck(a, b);
            return attempts > 1 ? "relay-retried" : "ok";
          })
        : blocked("relay"),
    );
    return results;
  } finally {
    for (const socket of sockets) socket.close();
    if (token) {
      try {
        const ended = await api("DELETE", `/v1/hosts/${host.serverId}`, {
          token,
        });
        check(ended.status === 204, "http-error");
      } catch {
        const discovery = results.find((r) => r.component === "discovery");
        if (discovery?.outcome === "pass")
          Object.assign(discovery, {
            outcome: "fail",
            reason: "host-cleanup",
            latencyMs: null,
          });
      }
    }
  }
}
async function relayStep(reason, work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProbeFailure && error.reason === "rate-limited")
      throw error;
    throw new ProbeFailure(
      reason,
      reason === "runner-error" ? "blocked" : "fail",
    );
  }
}

export async function verifyRelayPayloads(a, b, sleep = wait) {
  const channelA = 0x4000,
    channelB = 0x4001;
  const challenge = crypto.randomBytes(16).toString("hex");
  const sentA = new Set(),
    sentB = new Set();
  const received = (allocation, channel, expected) =>
    allocation.received.some(
      (frame) =>
        frame.kind === "channel" &&
        frame.channel === channel &&
        expected.has(frame.data),
    );
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fromA = `${challenge}:a:${attempt}`,
      fromB = `${challenge}:b:${attempt}`;
    sentA.add(fromA);
    sentB.add(fromB);
    await Promise.all([
      a.sendChannel(channelA, fromA),
      b.sendChannel(channelB, fromB),
    ]);
    for (let poll = 0; poll < 20; poll++) {
      if (received(a, channelA, sentB) && received(b, channelB, sentA))
        return attempt;
      await sleep(50);
    }
    if (received(a, channelA, sentB) && received(b, channelB, sentA))
      return attempt;
  }
  throw new ProbeFailure("relay-payload");
}

export async function relay(a, b) {
  function credentials(value) {
    const entry = value?.iceServers?.find(
      (s) =>
        typeof s?.username === "string" &&
        s.username &&
        typeof s.credential === "string" &&
        s.credential,
    );
    const udpUrl = /^turn:([a-zA-Z0-9.-]+):([1-9][0-9]{0,4})\?transport=udp$/;
    const url = entry?.urls?.find(
      (u) => typeof u === "string" && udpUrl.test(u),
    );
    check(url);
    const [, host, port] = udpUrl.exec(url);
    check(Number(port) <= 65535);
    return { entry, host, port: Number(port) };
  }
  const [ca, cb] = await relayStep("relay-credentials", () => {
    const ca = credentials(a),
      cb = credentials(b);
    check(ca.host === cb.host && ca.port === cb.port);
    return [ca, cb];
  });
  const server = {
    address: (
      await relayStep("relay-dns", () => dns.lookup(ca.host, { family: 4 }))
    ).address,
    port: ca.port,
  };
  let x, y;
  try {
    await relayStep("runner-error", async () => {
      x = new TurnAllocation(server, ca.entry.username, ca.entry.credential);
      y = new TurnAllocation(server, cb.entry.username, cb.entry.credential);
      await x.bind();
      await y.bind();
    });
    const [xa, ya] = await relayStep("relay-allocation", async () => {
      const xa = await x.allocate(),
        ya = await y.allocate();
      check(xa.family === 4 && ya.family === 4);
      check(xa.address !== ya.address || xa.port !== ya.port);
      return [xa, ya];
    });
    await relayStep("relay-permission", async () => {
      check(await x.permit(ya));
      check(await y.permit(xa));
    });
    await relayStep("relay-channel", async () => {
      check(await x.channel(0x4000, ya));
      check(await y.channel(0x4001, xa));
    });
    return await relayStep("relay-payload", () => verifyRelayPayloads(x, y));
  } finally {
    await Promise.allSettled([x?.release(), y?.release()]);
  }
}
