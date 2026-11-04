import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { TurnAllocation } from "../scripts/turn-probe.mjs";

test("the inherited TURN key derivation matches the RFC 5769 long-term authentication vector", async () => {
  // Data vector: https://www.rfc-editor.org/rfc/rfc5769.html#section-2.4
  // This establishes protocol compatibility; it does not waive security review.
  const allocation = new TurnAllocation(
    { address: "127.0.0.1", port: 9 },
    "マトリックス",
    "TheMatrIX",
  );
  let calls = 0;
  allocation.request = async () => {
    if (calls++ === 0)
      return {
        type: 0x0113,
        attributes: new Map([
          [0x0014, Buffer.from("example.org")],
          [0x0015, Buffer.from("f//499k954d6OL34oL9FSTvy64sA")],
        ]),
      };
    throw new Error("stop after derivation");
  };
  try {
    await assert.rejects(() => allocation.allocate(), /stop after derivation/);
    const message = Buffer.from(
      "000100602112a44278ad3433c6ad72c029da412e00060012e3839ee38388e383aae38383e382afe382b900000015001c662f2f3439396b39353464364f4c33346f4c394653547679363473410014000b6578616d706c652e6f726700",
      "hex",
    );
    assert.equal(
      crypto.createHmac("sha1", allocation.key).update(message).digest("hex"),
      "f67024656dd64a3e02b8e0712e85c9a28ca89666",
    );
  } finally {
    await allocation.release();
  }
});
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
