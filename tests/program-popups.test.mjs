import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { normalizePopups, publicPopups, safePopupUrl } from "../worker/program-popups.js";

/**
 * ההודעות הקופצות של אתר התוכניות (settings.popups): הכללים (worker/program-popups.js)
 * והפרסום עם הקטלוג — מול הוורקר הבנוי ו-SQLite אמיתי.
 */

function d1(db) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    async all() {
      const prepared = db.prepare(sql);
      try { return { results: prepared.all(...values), success: true }; }
      catch { return { results: [], success: true, meta: prepared.run(...values) }; }
    },
    async first(column) { const row = db.prepare(sql).get(...values) ?? null; return column && row ? row[column] : row; },
    async run() { return this.all(); },
  });
  return { prepare: (sql) => statement(sql), async batch(statements) { const out = []; for (const item of statements) out.push(await item.all()); return out; } };
}

async function sessionToken(db, email, token = `tok-${email.split("@")[0]}`) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)").run(hash, `sub-${email}`, email, "משתמש", null, Math.floor(Date.now() / 1000) + 3600);
  return token;
}

async function setup() {
  const url = new URL("../dist/server/index.js", import.meta.url);
  url.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(url.href);
  const db = new DatabaseSync(":memory:");
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const media = { async get() { return null; }, async put() {}, async head() { return null; }, async delete() {}, async list() { return { objects: [] }; } };
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  const admin = await sessionToken(db, "admin@example.com");
  const call = (path, { method = "GET", body, token } = {}) => worker.fetch(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", origin: "https://shmuel-lamed.github.io", "cf-connecting-ip": "1.2.3.4", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  return { call, admin };
}
const episode = { id: "ep-1", slug: "ep-1", title: "תוכנית", date: "2026-09-01", visible: true };
const publish = (call, token, settings) => call("/api/program/catalog", { method: "POST", token, body: { seasons: [], episodes: [episode], settings } });

test("normalizePopups keeps known fields, drops duplicates, unsafe links and unknown values", () => {
  assert.deepEqual(normalizePopups(undefined), []);
  const [a, ...rest] = normalizePopups([
    { id: "p1", enabled: true, kind: "weird", tone: "violet", title: "  שלום   לכולם ", text: "שורה\r\nשנייה", image: "http://x/a.jpg",
      buttons: [{ label: "לתוכנית", url: "episode.html?ep=a" }, { label: "רע", url: "javascript:alert(1)", style: "ghost" }, { label: "שלישי", url: "https://x" }],
      from: "2026-10-01", until: "2026-10-05T20:00:00", pages: ["home", "nope", "home"], audience: "x", freq: "daily", trigger: "scroll", delay: 9999, autoClose: -3, junk: 1 },
    { id: "p1", title: "כפול" }, { title: "בלי מזהה" }, { id: "p2", enabled: false, text: "כבויה" },
  ]);
  assert.deepEqual(a, {
    id: "p1", enabled: true, name: "", kind: "modal", tone: "violet", icon: "", title: "שלום לכולם", text: "שורה\nשנייה", image: "",
    buttons: [{ label: "לתוכנית", url: "episode.html?ep=a", style: "primary", newTab: false }, { label: "רע", url: "", style: "ghost", newTab: false }],
    from: "2026-10-01T00:00", until: "2026-10-05T20:00", pages: ["home"], audience: "all", visitors: "all", freq: "daily", trigger: "scroll",
    delay: 600, scroll: 50, autoClose: 0, rev: 0, createdAt: "",
  });
  assert.deepEqual(rest.map((p) => p.id), ["p2"]);
  assert.equal(safePopupUrl("//evil.example"), "");
  assert.equal(safePopupUrl("mailto:a@b.co"), "mailto:a@b.co");
  const list = normalizePopups([{ id: "on", enabled: true, text: "x" }, { id: "off", enabled: false, text: "x" }, { id: "empty", enabled: true }, { id: "past", enabled: true, text: "x", until: "2020-01-01T00:00" }]);
  assert.deepEqual(publicPopups(list, false, "2026-10-10T12:00").map((p) => p.id), ["on"]);
  assert.equal(publicPopups(list, true).length, 4, "admins see everything");
});

test("popups publish with the catalog; the public sees only live ones", async () => {
  const { call, admin } = await setup();
  assert.deepEqual((await (await call("/api/program/catalog")).json()).settings.popups, [], "nothing saved yet");
  const w = await publish(call, admin, { popups: [
    { id: "live", enabled: true, kind: "toast", title: "תוכנית חדשה", text: "האזינו עכשיו" },
    { id: "draft", enabled: false, title: "טיוטה" },
  ] });
  assert.equal(w.status, 200, await w.clone().text());
  const pub = (await (await call("/api/program/catalog")).json()).settings.popups;
  assert.deepEqual(pub.map((p) => [p.id, p.kind]), [["live", "toast"]]);
  await publish(call, admin, {});
  assert.equal((await (await call("/api/program/catalog")).json()).settings.popups.length, 1, "a publish without popups keeps them");
  await publish(call, admin, { popups: [] });
  assert.deepEqual((await (await call("/api/program/catalog")).json()).settings.popups, [], "an empty list removes them");
});
