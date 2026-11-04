import crypto from "node:crypto";
import dns from "node:dns/promises";
import { performance } from "node:perf_hooks";
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
  constructor(reason) {
    super(reason);
    this.reason = reason;
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
    await work();
    return {
      component,
      outcome: "pass",
      reason: "ok",
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      component,
      outcome: "fail",
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
export async function basic(api, config) {
  return [
    await stage("api", async () => {
      const s = await api("GET", "/v1/status");
      check(s.status === 200, "http-error");
      validateStatus(s.value);
      const browser = await api(
        "GET",
        `/v1/servers?build=${config.build}&protocol=${config.protocol}&limit=1`,
      );
      check(browser.status === 200, "http-error");
      check(
        Array.isArray(browser.value?.servers) &&
          browser.value.servers.length <= 1 &&
          (browser.value.next === null ||
            /^[0-9a-f]{64}$/.test(browser.value.next)),
      );
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
    let open = false;
    const fail = () => {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new ProbeFailure("http-error"));
      }
      waiters.clear();
      if (!open) reject(new ProbeFailure("http-error"));
    };
    socket.on("error", fail);
    socket.on("close", fail);
    socket.on("unexpected-response", () => {
      socket.terminate();
      fail();
    });
    socket.on("message", (data) => {
      let value;
      try {
        value = JSON.parse(data.toString());
      } catch {
        socket.terminate();
        return;
      }
      if (frames.length >= 64) {
        socket.terminate();
        return;
      }
      frames.push(value);
      for (const w of waiters)
        if (w.match(value)) {
          clearTimeout(w.timer);
          waiters.delete(w);
          w.resolve(value);
        }
    });
    socket.on("open", () => {
      open = true;
      resolve({
        socket,
        next: (match) =>
          new Promise((resolve, reject) => {
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
        close: () => socket.terminate(),
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
        const browser = await api(
          "GET",
          `/v1/servers?build=${config.build}&protocol=${config.protocol}&limit=1`,
        );
        check(browser.status === 200 && Array.isArray(browser.value?.servers));
        check(!browser.value.servers.some((s) => s.serverId === host.serverId));
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
            await a.next((f) => f.type === "welcome");
            const b = await socketFactory(
              config.origin,
              `/v1/signal/${host.serverId}`,
              ticket,
            );
            sockets.push(b);
            const welcome = await b.next((f) => f.type === "welcome");
            check(welcome.hostOnline === true && welcome.role === "peer");
            await a.next((f) => f.type === "joined");
          })
        : blocked("signaling"),
    );
    results.push(
      ticket
        ? await stage("relay", async () => {
            check(status.features.relay && !status.killSwitch, "disabled");
            const a = await api("POST", "/v1/turn/credentials", {
              token,
              body: { serverId: host.serverId },
            });
            check(a.status === 201, "http-error");
            const b = await api("POST", "/v1/turn/credentials", {
              token: ticket,
              body: { serverId: host.serverId },
            });
            check(b.status === 201, "http-error");
            await relayCheck(a.value, b.value);
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
        if (discovery)
          Object.assign(discovery, {
            outcome: "fail",
            reason: "probe-error",
            latencyMs: null,
          });
      }
    }
  }
}
export async function relay(a, b) {
  function credentials(value) {
    const entry = value?.iceServers?.find(
      (s) => typeof s.username === "string" && typeof s.credential === "string",
    );
    const url = entry?.urls?.find((u) =>
      /^turn:[a-zA-Z0-9.-]+:[0-9]+\?transport=udp$/.test(u),
    );
    check(url);
    const [, host, port] = /^turn:([^:]+):([0-9]+)/.exec(url);
    return { entry, host, port: Number(port) };
  }
  const ca = credentials(a),
    cb = credentials(b);
  check(ca.host === cb.host && ca.port === cb.port);
  const server = {
    address: (await dns.lookup(ca.host, { family: 4 })).address,
    port: ca.port,
  };
  const x = new TurnAllocation(server, ca.entry.username, ca.entry.credential),
    y = new TurnAllocation(server, cb.entry.username, cb.entry.credential);
  try {
    await x.bind();
    await y.bind();
    const xa = await x.allocate(),
      ya = await y.allocate();
    check(await x.permit(ya));
    check(await y.permit(xa));
    check(await x.channel(0x4000, ya));
    check(await y.channel(0x4001, xa));
    x.sendChannel(0x4000, "topiaforge-monitor-a");
    y.sendChannel(0x4001, "topiaforge-monitor-b");
    const until = performance.now() + 3000;
    while (
      performance.now() < until &&
      (!x.received.length || !y.received.length)
    )
      await new Promise((r) => setTimeout(r, 50));
    check(
      x.received.some((m) => m.data === "topiaforge-monitor-b") &&
        y.received.some((m) => m.data === "topiaforge-monitor-a"),
    );
  } finally {
    await Promise.allSettled([x.release(), y.release()]);
  }
}
