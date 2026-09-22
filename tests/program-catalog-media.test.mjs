import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * שני דברים נבדקים כאן:
 * 1. קטלוג התוכניות שפורסם באתר (data/episodes.json) נכתב ל-D1 בכל פעם
 *    ש-CATALOG_VERSION משתנה — כך שתיקון בקטלוג מגיע לאתר החי בפריסה בלי
 *    "פרסום" ידני, ונפילה בהבאתו אינה מקפיאה קטלוג ישן במקומו.
 * 2. ההקלטות מוגשות מהאחסון של האתר עצמו (R2) ברגע שהועתקו לשם, כולל
 *    בקשות Range, וכל עוד לא הועתקו — ההזרמה מהדרייב ממשיכה לעבוד
 *    וההעתקה נקבעת לרקע.
 */

function d1(db) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    async all() {
      const prepared = db.prepare(sql);
      try { return { results: prepared.all(...values), success: true }; }
      catch { return { results: [], success: true, meta: prepared.run(...values) }; }
    },
    async first(column) {
      const row = db.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] : row;
    },
    async run() { return this.all(); },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) { return Promise.all(statements.map((item) => item.all())); },
  };
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

/** דלי R2 בזיכרון, עם אותה סמנטיקת Range של R2 אמיתי. */
function bucket(files = new Map()) {
  const wrap = (key, buffer, part) => ({
    key,
    size: buffer.length,
    httpEtag: `"${key.length}-${buffer.length}"`,
    range: part,
    body: part ? buffer.subarray(part.offset, part.offset + part.length) : buffer,
    writeHttpMetadata(headers) { headers.set("content-type", "audio/mpeg"); },
  });
  return {
    files,
    async head(key) { const b = files.get(key); return b ? wrap(key, b) : null; },
    async get(key, options) {
      const b = files.get(key);
      if (!b) return null;
      const header = options?.range instanceof Headers ? options.range.get("range") : null;
      const m = header && /^bytes=(\d+)-(\d*)$/.exec(header);
      if (!m) return wrap(key, b);
      const offset = Number(m[1]);
      const end = m[2] === "" ? b.length - 1 : Number(m[2]);
      return wrap(key, b, { offset, length: end - offset + 1 });
    },
    async put(key, body) {
      const chunks = [];
      if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
      }
      files.set(key, Buffer.concat(chunks));
    },
    async delete(key) { files.delete(key); },
    async list() { return { objects: [] }; },
  };
}

const RECORDING = Buffer.from("ID3" + "x".repeat(997));
const DRIVE_ID = "1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4";

function env(files) {
  const db = new DatabaseSync(":memory:");
  return { DB: d1(db), MEDIA: bucket(files), ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) }, db };
}

const collect = () => { const jobs = []; return { jobs, ctx: { waitUntil: (p) => jobs.push(p), passThroughOnException() {} } }; };

const PUBLISHED = {
  seasons: [{ id: "slater", title: "קובי בלום וירמי סלייטר", year: 2026, note: "" }],
  episodes: [
    { id: `drive-${DRIVE_ID}`, slug: "episode-89", number: 89, season: "slater", title: "קדם מצעד האלבומים", date: "2026-09-13", description: "התיאור המלא מהמייל.", duration: 5280, visible: true, tags: [], guests: [], tracks: [], links: [] },
    { id: "drive-second", slug: "episode-88", number: 88, season: "slater", title: "מופעים כמו חול", date: "2026-08-08", description: "עוד תיאור מלא.", duration: 6060, visible: true, tags: [], guests: [], tracks: [], links: [] },
  ],
};

/** מגיש את הקטלוג שפורסם באתר, וסופר כמה פעמים הובא. */
function serveCatalogue(body = PUBLISHED) {
  const real = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = async (input, init) => {
    const href = String(input.url || input);
    if (href.includes("/Ringtones/data/episodes.json")) {
      calls.count += 1;
      return body ? new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }) : new Response("", { status: 404 });
    }
    return real(input, init);
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

test("the catalogue published on the site is written to D1 and refreshed when its version changes", async () => {
  const worker = await loadWorker();
  const e = env();
  const { ctx } = collect();
  const served = serveCatalogue();
  try {
  const first = await worker.fetch(new Request("http://localhost/api/program/catalog"), e, ctx);
  assert.equal(first.status, 200);
  const catalogue = await first.json();
  assert.equal(catalogue.episodes.length, 2, "the published catalogue is written as it is");
  assert.equal(catalogue.seasons.length, 1);
  assert.equal(catalogue.episodes.find((item) => item.number === 89).description, "התיאור המלא מהמייל.");
  const version = e.db.prepare("SELECT value_json FROM program_settings WHERE key='catalog_version'").get();
  assert.ok(version, "the catalogue version is recorded");
  assert.equal(served.calls.count, 1, "the published catalogue is fetched once");

  // עריכה מקומית שורדת כל עוד הגרסה לא השתנתה
  const sample = catalogue.episodes[0];
  e.db.prepare("UPDATE program_episodes SET data_json=? WHERE id=?")
    .run(JSON.stringify({ ...sample, title: "נערך באזור הניהול" }), sample.id);
  const again = await worker.fetch(new Request("http://localhost/api/program/catalog"), e, ctx);
  const edited = (await again.json()).episodes.find((item) => item.id === sample.id);
  assert.equal(edited.title, "נערך באזור הניהול", "an admin edit is not overwritten between versions");
  assert.equal(served.calls.count, 1, "and the catalogue is not fetched again");

  // גרסה חדשה מחזירה את הקטלוג שבמאגר
  e.db.prepare("UPDATE program_settings SET value_json=? WHERE key='catalog_version'").run(JSON.stringify("ישן"));
  const refreshed = await worker.fetch(new Request("http://localhost/api/program/catalog"), e, ctx);
  const restored = (await refreshed.json()).episodes.find((item) => item.id === sample.id);
  assert.equal(restored.title, sample.title, "a new version restores the catalogue published on the site");
  } finally { served.restore(); }
});

test("a catalogue that cannot be fetched leaves the live one alone, and is retried", async () => {
  const worker = await loadWorker();
  const e = env();
  const { ctx } = collect();

  const ok = serveCatalogue();
  try { await worker.fetch(new Request("http://localhost/api/program/catalog"), e, ctx); } finally { ok.restore(); }
  e.db.prepare("UPDATE program_settings SET value_json=? WHERE key='catalog_version'").run(JSON.stringify("ישן"));

  const down = serveCatalogue(null);
  try {
    const response = await worker.fetch(new Request("http://localhost/api/program/catalog"), e, ctx);
    assert.equal((await response.json()).episodes.length, 2, "the catalogue already in D1 keeps being served");
    const stored = JSON.parse(e.db.prepare("SELECT value_json FROM program_settings WHERE key='catalog_version'").get().value_json);
    assert.equal(stored, "ישן", "the version is not advanced, so the next request tries again");
    assert.equal(down.calls.count, 1);
  } finally { down.restore(); }
});

test("a recording already copied to the site's storage is served from it, with Range", async () => {
  const worker = await loadWorker();
  const e = env(new Map([[`program/drive/${DRIVE_ID}.mp3`, RECORDING]]));
  const { ctx, jobs } = collect();

  const whole = await worker.fetch(new Request(`http://localhost/api/program/stream/${DRIVE_ID}`), e, ctx);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "audio/mpeg");
  assert.equal(whole.headers.get("content-length"), String(RECORDING.length));
  assert.equal(whole.headers.get("accept-ranges"), "bytes");

  const part = await worker.fetch(new Request(`http://localhost/api/program/stream/${DRIVE_ID}`, { headers: { range: "bytes=10-19" } }), e, ctx);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 10-19/${RECORDING.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), RECORDING.subarray(10, 20).toString());
  assert.equal(jobs.length, 0, "nothing is copied when the recording is already here");
});

test("a recording that is not here yet still plays from Drive, and is copied in the background", async () => {
  const worker = await loadWorker();
  const e = env();
  const { ctx, jobs } = collect();
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input.url || input), /drive\.usercontent\.google\.com/);
    return new Response(RECORDING, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(RECORDING.length) } });
  };
  try {
    const response = await worker.fetch(new Request(`http://localhost/api/program/stream/${DRIVE_ID}`), e, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(jobs.length, 1, "the copy is scheduled in the background");
    await Promise.all(jobs);
    assert.ok(e.MEDIA.files.has(`program/drive/${DRIVE_ID}.mp3`), "the recording now lives on the site");
  } finally { globalThis.fetch = real; }
});
