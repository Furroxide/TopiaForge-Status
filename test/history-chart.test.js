import { test } from "node:test";
import assert from "node:assert/strict";
import { activityPlot, availabilityBuckets } from "../public/history-chart.js";
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
test("the timeline distinguishes missing checks from time outside monitoring", () => {
  const from = 1893456000;
  const history = { from, to: from + 86400 };
  const component = {
    startedAt: from + 1800,
    points: [{ at: from + 1800, outcome: "pass" }],
    daily: [],
  };
  const buckets = availabilityBuckets(history, component, 300);
  assert.equal(buckets[0].state, "outside");
  assert.equal(buckets[1].state, "partial");
  assert.equal(buckets[2].state, "gap");
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.expected, 0),
    282,
  );
  assert.ok(
    availabilityBuckets(
      history,
      { startedAt: null, points: [], daily: [] },
      300,
    ).every((bucket) => bucket.expected === 0 && bucket.state === "outside"),
  );
});
test("activity shows isolated samples and breaks the line across missing or withheld counts", () => {
  const data = {
    from: 0,
    to: 2400,
    activity: [
      { schema: "topiaforge.activity/2", scope: "public", sampledAt: 300, state: "available", sessionsBand: { min: 5, max: 9 }, playersBand: { min: 10, max: 19 } },
      { sampledAt: 600, state: "suppressed", players: null },
      { schema: "topiaforge.activity/2", scope: "public", sampledAt: 900, state: "available", sessionsBand: { min: 5, max: 9 }, playersBand: { min: 10, max: 19 } },
      { schema: "topiaforge.activity/2", scope: "public", sampledAt: 1200, state: "available", sessionsBand: { min: 5, max: 9 }, playersBand: { min: 20, max: 29 } },
      { schema: "topiaforge.activity/2", scope: "public", sampledAt: 1800, state: "available", sessionsBand: { min: 5, max: 9 }, playersBand: { min: 10, max: 19 } },
    ],
  };
  const plot = activityPlot(data);
  const commands = plot.path.split(" ");
  assert.equal(plot.peak, 20);
  assert.match(commands[0], /^M.*h0$/);
  assert.match(commands[1], /^M[^h]+$/);
  assert.match(commands[2], /^L/);
  assert.match(commands[3], /^M.*h0$/);
  assert.equal(commands.length, 4);
  assert.equal(activityPlot({ ...data, activity: [data.activity[1]] }), null);
});

test("a mixed-version activity response cannot show legacy exact values in the chart", () => {
  assert.equal(activityPlot({ from: 0, to: 2400, activity: [
    { sampledAt: 300, state: "available", sessions: 7, players: 19 },
    { schema: "topiaforge.activity/1", sampledAt: 600, state: "available", sessions: 7, players: 19 },
  ] }), null);
});
