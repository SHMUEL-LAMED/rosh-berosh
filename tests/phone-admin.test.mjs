import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { reorderIds, shiftIds } from "../worker/reorder.js";

const require = createRequire(import.meta.url);
const { ADMIN_SECTIONS, HANGUP_CODE, MAIN_MENU_CODE, adminCodes, adminItems, adminReadOptions, resolveAdminCode } = require("../ivr-service/src/admin-menu.js");

const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("every management action has its own two digit code", () => {
  const codes = adminCodes();
  assert.deepEqual([...new Set(codes)], codes, "יש קוד כפול בתפריט");
  for (const code of codes) assert.match(code, /^\d{2}$/, code);
  for (const section of ADMIN_SECTIONS) {
    assert.match(section.code, /^[1-9]0$/, section.code);
    for (const item of section.items) {
      assert.equal(item.code[0], section.code[0], `${item.code} אינו שייך לנושא ${section.code}`);
      assert.notEqual(item.code, section.code);
    }
  }
  assert.ok(codes.includes(MAIN_MENU_CODE) && codes.includes(HANGUP_CODE));
});

test("the admin line always reads exactly two digits, so no menu waits for a timeout", () => {
  const options = adminReadOptions();
  assert.equal(options.min_digits, 2);
  assert.equal(options.max_digits, 2);
  assert.deepEqual(options.digits_allowed, adminCodes());
});

test("every code in the map is wired to a handler in the IVR", () => {
  const server = source("ivr-service/src/server.js");
  const handlers = new Set([...server.matchAll(/^ {2}"([a-z-]+)":/gm)].map((match) => match[1]));
  for (const item of adminItems()) {
    assert.ok(handlers.has(item.action), `אין מימוש לפעולה ${item.action} (קוד ${item.code})`);
  }
});

test("every action the phone sends is handled by the worker", () => {
  const server = source("ivr-service/src/server.js");
  const worker = source("worker/ivr-admin.ts");
  const sent = new Set([...server.matchAll(/\baction: "([a-z-]+)"/g)].map((match) => match[1]));
  const handled = new Set([...worker.matchAll(/body\.action === "([a-z-]+)"/g)].map((match) => match[1]));
  assert.ok(sent.size >= 20, `נמצאו רק ${sent.size} פעולות בקו`);
  for (const action of sent) assert.ok(handled.has(action), `הוורקר אינו מכיר את הפעולה ${action}`);
});

test("a keyed code routes to its topic, action, main menu or hangup", () => {
  assert.equal(resolveAdminCode(HANGUP_CODE).type, "hangup");
  assert.equal(resolveAdminCode("").type, "hangup");
  assert.equal(resolveAdminCode(MAIN_MENU_CODE).type, "main");

  const topic = resolveAdminCode("50");
  assert.equal(topic.type, "section");
  assert.equal(topic.section.code, "50");

  const action = resolveAdminCode("54");
  assert.equal(action.type, "action");
  assert.equal(action.item.action, "item-toggle");
  assert.equal(action.section.code, "50", "פעולה מחזירה את הנושא שלה כדי להישאר בו");

  assert.equal(resolveAdminCode("07").type, "unknown");
});

test("every action is reachable directly from the main menu without browsing", () => {
  for (const item of adminItems()) {
    const resolved = resolveAdminCode(item.code);
    assert.equal(resolved.type, "action", item.code);
    assert.equal(resolved.item.action, item.action);
  }
});

test("moving an item up or down swaps it with its neighbour", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(shiftIds(ids, "c", -1), ["a", "c", "b", "d"]);
  assert.deepEqual(shiftIds(ids, "c", 1), ["a", "b", "d", "c"]);
  assert.equal(shiftIds(ids, "a", -1), null);
  assert.equal(shiftIds(ids, "d", 1), null);
  assert.equal(shiftIds(ids, "z", 1), null);
  assert.deepEqual(ids, ["a", "b", "c", "d"], "המערך המקורי השתנה");
});

test("moving an item to an exact place keeps every other item in order", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(reorderIds(ids, "d", 1), ["d", "a", "b", "c"]);
  assert.deepEqual(reorderIds(ids, "a", 4), ["b", "c", "d", "a"]);
  assert.deepEqual(reorderIds(ids, "b", 2), ["a", "b", "c", "d"]);
  assert.equal(reorderIds(ids, "b", 0), null);
  assert.equal(reorderIds(ids, "b", 5), null);
  assert.equal(reorderIds(ids, "b", 1.5), null);
  assert.equal(reorderIds(ids, "z", 1), null);
  assert.deepEqual(ids, ["a", "b", "c", "d"], "המערך המקורי השתנה");
});
