import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credential, writeStatus } from "../scripts/monitor.mjs";

test("systemd credentials supply secrets without environment values", () => {
  const directory = mkdtempSync(join(tmpdir(), "topiaforge-monitor-"));
  try {
    writeFileSync(join(directory, "STATUS_INGEST_TOKEN"), "file-token\n");
    writeFileSync(join(directory, "MONITOR_SIGNING_KEY"), "pem-line-1\npem-line-2\n");
    const environment = { CREDENTIALS_DIRECTORY: directory };
    assert.equal(credential("STATUS_INGEST_TOKEN", environment), "file-token");
    assert.equal(credential("MONITOR_SIGNING_KEY", environment), "pem-line-1\npem-line-2");
    assert.equal(credential("MONITOR_ACTIVITY_TOKEN", environment), undefined);
    assert.equal(
      credential("STATUS_INGEST_TOKEN", { ...environment, STATUS_INGEST_TOKEN: "github-token" }),
      "github-token",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a lost acknowledgement and a temporary storage failure replay the same measurement", async () => {
  const requests = [];
  const result = await writeStatus(
    "/internal/observations",
    { runId: "10-1", slot: 300 },
    "test-token",
    {
      wait: async () => {},
      fetchImpl: async (url, request) => {
        requests.push({ url, body: request.body });
        if (requests.length === 1)
          throw new TypeError("connection interrupted");
        if (requests.length === 2) return new Response(null, { status: 503 });
        return Response.json({ accepted: true });
      },
    },
  );
  assert.deepEqual(result, { accepted: true });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.body === requests[0].body));
  assert.equal(
    requests[0].url,
    "https://status.topiaforge.dev/internal/observations",
  );
});

test("storage rejection is reported once without retrying or exposing its body", async () => {
  let attempts = 0;
  await assert.rejects(
    writeStatus("/internal/observations", {}, "test-token", {
      fetchImpl: async () => {
        attempts++;
        return new Response("test-only-private-diagnostic", { status: 409 });
      },
    }),
    { message: "Status storage rejected the request (HTTP 409)." },
  );
  assert.equal(attempts, 1);
});
