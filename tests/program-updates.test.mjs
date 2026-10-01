import assert from "node:assert/strict";
import test from "node:test";

/**
 * עורך העדכונים בניהול (programs-updates.tsx): טעינת הטיוטה שומרת את הכפתורים והקבצים
 * המצורפים (אחרת פרסום מהניהול היה מוחק אותם), והטקסט מפוענח לקישורים בטוחים בלבד.
 */

const load = async (t, path) => {
  const mod = await import(path).catch(() => null);
  if (!mod) t.skip("this Node cannot load TypeScript directly");
  return mod;
};

test("loading the catalog keeps an update's link buttons and attached files", async (t) => {
  const core = await load(t, "../app/admin/programs-core.ts"); if (!core) return;
  const data = core.normCatalog({ seasons: [], episodes: [], settings: { updates: [
    { id: "u-1", date: "2026-10-01", title: "קבצים", text: "ראו [כאן](https://x.test)", links: [{ label: "להרשמה", url: "https://x.test/join" }], files: [{ name: "לוח", url: "https://w.dev/media/program/u-1/a.pdf", size: 1200, type: "application/pdf" }, { name: "בלי כתובת" }] },
    { id: "u-2", title: "ישן", text: "", link: "updates.html" },
  ] } });
  const [rich, old] = data.settings.updates;
  assert.deepEqual(rich.links, [{ label: "להרשמה", url: "https://x.test/join" }]);
  assert.deepEqual(rich.files, [{ name: "לוח", url: "https://w.dev/media/program/u-1/a.pdf", size: 1200, type: "application/pdf" }]);
  assert.deepEqual([old.link, old.links, old.files], ["updates.html", [], []], "an old update keeps its single link");
});

test("update text: links on words, bold and bare addresses — only safe ones become links", async (t) => {
  const { parseUpdateText, updateUrl, badLinks, fileKindOf, fmtSize } = await load(t, "../app/admin/update-text.ts") || {}; if (!parseUpdateText) return;
  const [[first, second], [third]] = parseUpdateText("שלום [להרשמה](https://x.test/a?b=1) ו**חשוב**\nשורה https://site.test/x.\n\nפסקה");
  assert.deepEqual(first, [{ kind: "text", text: "שלום " }, { kind: "link", text: "להרשמה", url: "https://x.test/a?b=1" }, { kind: "text", text: " ו" }, { kind: "bold", text: "חשוב" }]);
  assert.deepEqual(second, [{ kind: "text", text: "שורה " }, { kind: "link", text: "site.test/x", url: "https://site.test/x", bare: true }, { kind: "text", text: "." }]);
  assert.deepEqual(third, [{ kind: "text", text: "פסקה" }]);
  const unsafe = parseUpdateText("[x](javascript:alert(1)) [y](//evil.test) [z](data:text/html,1)").flat(2);
  assert.ok(unsafe.every((s) => s.kind !== "link"), "unsafe targets stay plain text");
  assert.equal(updateUrl("mailto:a@b.co"), "mailto:a@b.co");
  assert.equal(updateUrl("updates.html"), "updates.html");
  assert.deepEqual(badLinks("[טוב](https://x.test) [רע](javascript:1)"), ["רע"]);
  assert.deepEqual(fileKindOf({ name: "לוח", url: "https://w.dev/a.pdf" }), { icon: "📄", label: "PDF" });
  assert.equal(fmtSize(2.5 * 1024 * 1024), "2.5 MB");
});
