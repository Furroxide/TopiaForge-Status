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
  const first =
    Math.floor(
      Math.max(history.from, component.startedAt ?? history.from) / cadence,
    ) * cadence;
  for (let at = first; at <= history.to; at += cadence)
    buckets[index(at)].expected++;
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
        : "",
  }));
}
