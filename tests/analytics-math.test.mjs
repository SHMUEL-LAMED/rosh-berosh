import assert from "node:assert/strict";
import test from "node:test";
import {
  competitionPlaces,
  concentrationIndex,
  giniCoefficient,
  israelOffsetSeconds,
  israelParts,
  pearson,
  percentile,
  projectTotal,
  summarize,
} from "../worker/analytics-math.js";

const at = (iso) => Math.floor(Date.parse(iso) / 1000);

test("Israeli daylight saving is resolved without Intl, so the worker buckets votes by local time", () => {
  assert.equal(israelOffsetSeconds(at("2026-01-15T12:00:00Z")), 2 * 3600, "winter is UTC+2");
  assert.equal(israelOffsetSeconds(at("2026-07-15T12:00:00Z")), 3 * 3600, "summer is UTC+3");
  // ב-2026 שעון הקיץ מתחיל ביום שישי 27 במרץ ומסתיים ביום ראשון 25 באוקטובר.
  assert.equal(israelOffsetSeconds(at("2026-03-26T12:00:00Z")), 2 * 3600, "the day before the switch is still winter");
  assert.equal(israelOffsetSeconds(at("2026-03-28T12:00:00Z")), 3 * 3600, "the day after the switch is summer");
  assert.equal(israelOffsetSeconds(at("2026-10-24T12:00:00Z")), 3 * 3600, "still summer the day before the October switch");
  assert.equal(israelOffsetSeconds(at("2026-11-01T12:00:00Z")), 2 * 3600, "back to winter in November");
});

test("local hour, weekday and day start are derived from a UTC stamp", () => {
  const evening = israelParts(at("2026-07-15T18:30:00Z"));
  assert.equal(evening.hour, 21, "18:30 UTC in July is 21:30 in Israel");
  assert.equal(evening.weekday, 3, "15 July 2026 is a Wednesday");
  assert.equal(new Date(evening.dayStart * 1000).toISOString(), "2026-07-14T21:00:00.000Z", "the local day starts at midnight Israel time");
  // חצות מקומית שייכת ליום שהתחיל, לא ליום שלפניו.
  const justAfterMidnight = israelParts(at("2026-01-10T22:30:00Z"));
  assert.equal(justAfterMidnight.hour, 0);
  assert.equal(justAfterMidnight.weekday, 0, "00:30 Sunday local, although it is Saturday in UTC");
});

test("percentiles interpolate and survive degenerate inputs", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3], 0.5), 2);
  assert.equal(percentile([10], 0.9), 10, "a single value is every percentile");
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([5, 9], 2), 9, "a fraction above one is clamped");
});

test("summarize reports the whole distribution and an empty set is all zeros", () => {
  assert.deepEqual(summarize([10, 20, 30, 40]), { count: 4, average: 25, median: 25, p25: 18, p75: 33, p90: 37, min: 10, max: 40, total: 100 });
  assert.deepEqual(summarize([]), { count: 0, average: 0, median: 0, p25: 0, p75: 0, p90: 0, min: 0, max: 0, total: 0 });
  assert.equal(summarize([5, -3, Number.NaN, 7]).count, 2, "negative and non-finite durations are dropped, not counted as zero");
});

test("concentration separates a landslide from an open race", () => {
  assert.equal(concentrationIndex([10, 10, 10, 10]), 0, "a perfect tie is the least concentrated race possible");
  assert.equal(concentrationIndex([100]), 100, "one item holding everything is total concentration");
  assert.ok(concentrationIndex([100, 1, 1, 1]) > 80, "one runaway leader reads as concentrated");
  assert.ok(concentrationIndex([10, 9, 8, 7]) < 10, "a close field reads as open");
  assert.equal(concentrationIndex([]), 0, "no votes is not a landslide");
});

test("the Gini coefficient measures how unevenly votes are spread", () => {
  assert.equal(giniCoefficient([5, 5, 5, 5]), 0);
  assert.equal(giniCoefficient([0, 0, 0, 20]), 0.75);
  assert.equal(giniCoefficient([7]), 0, "a single item has no inequality to measure");
});

test("correlation detects position bias and refuses to report one without variance", () => {
  assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1);
  assert.equal(pearson([1, 2, 3], [5, 5, 5]), null, "every item tied means there is no correlation to report");
  assert.equal(pearson([1, 2], [3, 4]), null, "two points are not evidence");
});

test("the projection refuses to guess without a rate or a deadline", () => {
  assert.equal(projectTotal({ current: 100, windowVotes: 10, windowSeconds: 3600, secondsRemaining: 7200 }), 120);
  assert.equal(projectTotal({ current: 100, windowVotes: 0, windowSeconds: 3600, secondsRemaining: 7200 }), null, "a dead window projects nothing");
  assert.equal(projectTotal({ current: 100, windowVotes: 10, windowSeconds: 3600, secondsRemaining: 0 }), null, "a closed poll has nothing to project");
});

test("ties share a place and the next place skips, as in a real chart", () => {
  const places = competitionPlaces([{ id: "a", v: 5 }, { id: "b", v: 5 }, { id: "c", v: 1 }], (entry) => entry.v);
  assert.equal(places.get("a"), 1);
  assert.equal(places.get("b"), 1);
  assert.equal(places.get("c"), 3, "after two firsts the next item is third, not second");
});
