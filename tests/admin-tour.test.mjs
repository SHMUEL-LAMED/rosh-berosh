import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * סיור ההדרכה בניהול (app/admin/admin-tour.tsx) מאיר אזורים לפי בורר. אם מישהו משנה שם
 * של מחלקה, מזהה או data-tour, הסיור לא נשבר בשקט — הבדיקה הזו נכשלת: כל בורר בסיור
 * חייב להופיע בקוד של דף הניהול, וכל לשונית בסיור חייבת להיות לשונית אמיתית.
 */

const dir = new URL("../app/admin/", import.meta.url);
const tour = readFileSync(new URL("admin-tour.tsx", dir), "utf8");
const sources = readdirSync(dir).filter((name) => name.endsWith(".tsx") && name !== "admin-tour.tsx").map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
const steps = [...tour.matchAll(/\{ (?:tab: "([^"]+)", )?(?:target: (?:"([^"]+)"|'([^']+)'), )?title: "([^"]+)"/g)].map((m) => ({ tab: m[1], target: m[2] || m[3], title: m[4] }));

test("the tour has steps, each with a title", () => {
  assert.ok(steps.length >= 8, `found ${steps.length} steps`);
});

test("every highlighted area in the tour exists in the admin page", () => {
  for (const { target, title } of steps) {
    if (!target) continue;
    // כל חלק בבורר: [data-tour="x"], #id או .class
    for (const [, attr, id, cls] of target.matchAll(/\[data-tour="([^"]+)"\]|#([\w-]+)|\.([\w-]+)/g)) {
      const ok = attr ? sources.includes(`data-tour="${attr}"`) : id ? sources.includes(`id="${id}"`) : new RegExp(`className=(?:"|\\{\`)[^"\`]*\\b${cls}\\b`).test(sources);
      assert.ok(ok, `step "${title}": ${target} not found in app/admin`);
    }
  }
});

test("every tab the tour opens is a real admin tab", () => {
  const page = readFileSync(new URL("page.tsx", dir), "utf8");
  const tabs = new Set([...page.match(/const TABS: Tab\[\] = \[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  for (const { tab, title } of steps) if (tab) assert.ok(tabs.has(tab), `step "${title}": unknown tab ${tab}`);
});
