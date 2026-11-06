const DAY = 86400;
export function availabilityBuckets(history, component, cadence) {
  const archived = history.to - history.from > 30 * DAY;
  const width = archived ? DAY : (history.to - history.from) / 48;
  const count = archived ? Math.ceil((history.to - history.from) / DAY) : 48;
  const buckets = Array.from({ length: count }, (_, i) => ({
    from: history.from + i * width,
    to: Math.min(history.to, history.from + (i + 1) * width),
    passed: 0,
    failed: 0,
    expected: 0,
  }));
  const index = (at) =>
    Math.max(0, Math.min(count - 1, Math.floor((at - history.from) / width)));
  if (component.startedAt != null) {
    const windowSlot = Math.floor(history.from / cadence) * cadence;
    const firstInWindow =
      history.from === windowSlot || component.points[0]?.at === windowSlot
        ? windowSlot
        : windowSlot + cadence;
    const first = Math.max(
      firstInWindow,
      Math.floor(component.startedAt / cadence) * cadence,
    );
    const currentSlot = Math.floor(history.to / cadence) * cadence;
    const last =
      component.points.at(-1)?.at === currentSlot
        ? currentSlot
        : currentSlot - cadence;
    for (let at = first; at <= last; at += cadence)
      buckets[index(at)].expected++;
  }
  for (const point of component.points) {
    if (point.at > history.to) continue;
    const b = buckets[index(point.at)];
    if (point.outcome === "pass") b.passed++;
    else if (point.outcome === "fail") b.failed++;
  }
  // Calendar-day archives occupy calendar-day bins. Never infer the exact
  // sub-day position of archived failures from daily counts.
  for (const day of component.daily) {
    const b = buckets[index(day.at)];
    b.passed += day.passed;
    b.failed += day.failed;
  }
  return buckets.map((b) => ({
    ...b,
    state: b.failed
      ? b.passed
        ? "mixed"
        : "fail"
      : b.passed
        ? b.passed >= b.expected
          ? "pass"
          : "partial"
        : b.expected
          ? "gap"
          : "outside",
  }));
}

export function activityPlot({ activity, from, to }) {
  const max = activity.reduce(
    (peak, sample) =>
      sample.state === "available" ? Math.max(peak, sample.players) : peak,
    0,
  );
  if (!max || to <= from) return null;
  const adjacent = (earlier, later) =>
    earlier?.state === "available" &&
    later?.state === "available" &&
    later.sampledAt - earlier.sampledAt === 300;
  const commands = [];
  for (let index = 0; index < activity.length; index++) {
    const sample = activity[index];
    if (sample.state !== "available") continue;
    const x = 5 + (990 * (sample.sampledAt - from)) / (to - from);
    const y = 140 - (130 * sample.players) / max;
    const continues = adjacent(activity[index - 1], sample);
    const point = `${continues ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    // A move alone has no stroke. The round cap makes a lone sample visible.
    commands.push(
      !continues && !adjacent(sample, activity[index + 1])
        ? `${point}h0`
        : point,
    );
  }
  return { path: commands.join(" "), peak: max };
}
