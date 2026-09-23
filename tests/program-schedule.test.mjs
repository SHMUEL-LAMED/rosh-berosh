import assert from "node:assert/strict";
import test from "node:test";
import { isPublic, isScheduled, israelHour, israelWallClock, normalizePublishAt } from "../worker/program-schedule.js";

/** publishAt נכתב בשעון ישראל; ההשוואה חייבת לכבד שעון קיץ וחורף. */

test("the Israel wall clock follows daylight saving time", () => {
  assert.equal(israelWallClock(Date.UTC(2026, 6, 1, 12, 0)), "2026-07-01T15:00", "summer: UTC+3");
  assert.equal(israelWallClock(Date.UTC(2026, 0, 1, 12, 0)), "2026-01-01T14:00", "winter: UTC+2");
  assert.equal(israelWallClock(Date.UTC(2026, 9, 1, 21, 30)), "2026-10-02T00:30", "crosses midnight");
  assert.equal(israelHour(Date.UTC(2026, 9, 1, 21, 30)), 0);
  assert.equal(israelHour(Date.UTC(2026, 0, 1, 21, 59)), 23);
});

test("publishAt values are normalized and compared as local Israel time", () => {
  assert.equal(normalizePublishAt("2026-10-01T20:00"), "2026-10-01T20:00");
  assert.equal(normalizePublishAt("2026-10-01 20:00:30"), "2026-10-01T20:00");
  assert.equal(normalizePublishAt("2026-10-01"), "2026-10-01T00:00");
  assert.equal(normalizePublishAt(""), "");
  assert.equal(normalizePublishAt("soon"), "");
  const now = "2026-10-01T19:59";
  assert.equal(isScheduled({ publishAt: "2026-10-01T20:00" }, now), true);
  assert.equal(isScheduled({ publishAt: "2026-10-01T19:59" }, now), false);
  assert.equal(isScheduled({}, now), false);
  // 17:00 UTC בקיץ היא 20:00 בישראל
  assert.equal(isScheduled({ publishAt: "2026-07-01T20:00" }, israelWallClock(Date.UTC(2026, 6, 1, 16, 59))), true);
  assert.equal(isScheduled({ publishAt: "2026-07-01T20:00" }, israelWallClock(Date.UTC(2026, 6, 1, 17, 0))), false);
  assert.equal(isPublic({ visible: false }, false, now), false);
  assert.equal(isPublic({ publishAt: "2020-01-01T00:00" }, true, now), true);
});
