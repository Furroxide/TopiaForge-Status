import { test } from "node:test";
import assert from "node:assert/strict";
import { availabilityBuckets } from "../public/history-chart.js";
test("fully covered 90-day history stays green across the archive boundary", () => {
  const DAY = 86400,
    from = 1893456000,
    to = from + 90 * DAY - 1;
  const component = { startedAt: from, daily: [], points: [] };
  for (let d = 0; d < 60; d++)
    component.daily.push({
      at: from + d * DAY,
      passed: 288,
      failed: 0,
      blocked: 0,
    });
  for (let at = from + 60 * DAY; at <= to; at += 300)
    component.points.push({ at, outcome: "pass" });
  const bars = availabilityBuckets({ from, to }, component, 300);
  assert.equal(bars.length, 90);
  assert.ok(bars.every((b) => b.state === "pass"));
  assert.equal(
    bars.reduce((n, b) => n + b.passed, 0),
    90 * 288,
  );
});
test("missing checks remain visibly partial and current boundary samples are included", () => {
  const history = { from: 1893456000, to: 1893456000 + 86400 };
  const component = {
    startedAt: history.from,
    points: [
      { at: history.from, outcome: "pass" },
      { at: history.to, outcome: "pass" },
    ],
    daily: [],
  };
  const bars = availabilityBuckets(history, component, 300);
  assert.equal(bars[0].state, "partial");
  assert.equal(bars.at(-1).passed, 1);
  assert.equal(
    bars.reduce((n, b) => n + b.passed, 0),
    2,
  );
});
