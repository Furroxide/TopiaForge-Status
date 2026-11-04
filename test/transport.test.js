import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { TurnAllocation } from "../scripts/turn-probe.mjs";
test("UDP probe ignores malformed and foreign frames and cleans pending requests on socket error", async () => {
  const server = dgram.createSocket("udp4");
  await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));
  const allocation = new TurnAllocation(
    { address: "127.0.0.1", port: server.address().port },
    "test-user",
    "test-credential",
  );
  try {
    await allocation.bind("127.0.0.1");
    server.send(
      Buffer.from([0x40, 0, 0, 20]),
      allocation.socket.address().port,
      "127.0.0.1",
    );
    const request = allocation.request(3, [], false);
    allocation.socket.emit("error", new Error("test-only socket failure"));
    await assert.rejects(request, /TURN request failed/);
    assert.equal(allocation.pending.size, 0);
    assert.equal(allocation.received.length, 0);
    await allocation.release();
    await allocation.release();
    assert.equal(allocation.closed, true);
  } finally {
    await allocation.release();
    server.close();
  }
});
