import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * סיורי ההדרכה בניהול (app/admin/admin-tour.tsx) — הקצר, המקיף וההסבר של כל חלק — מאירים
 * אזורים לפי בורר. אם מישהו משנה שם של מחלקה, מזהה או data-tour, הסיור לא נשבר בשקט: כל
 * בורר בסיורים חייב להופיע בקוד של דף הניהול, וכל לשונית בסיורים חייבת להיות לשונית אמיתית.
 */

const dir = new URL("../app/admin/", import.meta.url);
const tour = readFileSync(new URL("admin-tour.tsx", dir), "utf8");
const page = readFileSync(new URL("page.tsx", dir), "utf8");
const sources = readdirSync(dir).filter((name) => name.endsWith(".tsx") && name !== "admin-tour.tsx").map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
const tabs = new Set([...page.match(/const TABS: Tab\[\] = \[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
const constants = Object.fromEntries([...tour.matchAll(/^const (\w+) = '([^']+)';$/gm)].map((m) => [m[1], m[2]]));
// כל הבוררים: target / click / open, כמחרוזת או דרך קבוע (PICK_EPISODE וכו')
const selectors = [...tour.matchAll(/\b(target|click|open): (?:"([^"]+)"|'([^']+)'|(\w+))/g)].map((m) => ({ kind: m[1], selector: m[2] || m[3] || constants[m[4]] }));
const titles = [...tour.matchAll(/title: "([^"]+)", body: "([^"]*)"/g)];

test("the tours have steps, each with a title and an explanation", () => {
  assert.ok(titles.length >= 30, `found ${titles.length} steps`);
  for (const [, title, body] of titles) assert.ok(body.length > 20, `step "${title}" needs an explanation`);
});

test("every area the tours highlight, click or open exists in the admin page", () => {
  assert.ok(selectors.length >= 30);
  for (const { kind, selector } of selectors) {
    assert.ok(selector, `${kind}: unknown constant`);
    for (const [, attr, id, cls] of selector.matchAll(/\[data-tour="([^"]+)"\]|#([\w-]+)|\.([\w-]+)/g)) {
      const ok = attr ? sources.includes(`data-tour="${attr}"`) : id ? sources.includes(`id="${id}"`) : new RegExp(`className=(?:"|\\{\`)[^"\`]*\\b${cls}\\b`).test(sources);
      assert.ok(ok, `${kind} ${selector} not found in app/admin`);
    }
  }
});

test("every tab the tours open, and every section with a „?” explanation, is a real admin tab", () => {
  for (const [, tab] of tour.matchAll(/tab: "([^"]+)"/g)) assert.ok(tabs.has(tab), `unknown tab ${tab}`);
  const sections = tour.slice(tour.indexOf("SECTION_TOURS"), tour.indexOf("SECTION_TITLES"));
  const keys = [...sections.matchAll(/^  "(prog-[\w-]+)": \[/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 6, `found ${keys.length} sections`);
  for (const key of keys) {
    assert.ok(tabs.has(key), `section tour for unknown tab ${key}`);
    assert.match(tour, new RegExp(`"${key}": "[^"]+"`), `SECTION_TITLES is missing ${key}`);
  }
  // כל חלק של אתר התוכניות מקבל הסבר
  for (const tab of tabs) if (tab.startsWith("prog-")) assert.ok(keys.includes(tab), `no „?” explanation for ${tab}`);
});
