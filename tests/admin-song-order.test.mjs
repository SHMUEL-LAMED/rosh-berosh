import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * בדיקה מקצה לקצה על הוורקר הבנוי מול SQLite אמיתי.
 * הבדיקה נועדה לתפוס שגיאות זמן ריצה בנתיבי הניהול — כמו פונקציית עזר
 * שנקראת בלי שיובאה — שאינן נתפסות בבנייה, כי תיקיית `worker` אינה עוברת tsc.
 */

// עטיפת D1 מעל node:sqlite. D1 מחזיר {results} ל-all ושורה בודדת ל-first.
function d1(db) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    // D1 מחזיר `results` גם ל-`batch` וגם ל-`all`, גם למשפטי כתיבה.
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

const media = {
  async get() { return null; },
  async put() {},
  async delete() {},
  async list() { return { objects: [] }; },
};

async function sessionCookie(db, email) {
  const token = "test-session-token";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
    .run(hash, "sub-1", email, "מנהל", null, Math.floor(Date.now() / 1000) + 3600);
  return `rosh_session=${token}`;
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };

async function setup() {
  const worker = await loadWorker();
  const db = new DatabaseSync(":memory:");
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  // הבקשה הראשונה בונה את הסכמה כולה, בדיוק כמו בייצור.
  await worker.fetch(new Request("http://localhost/api/admin/overview"), env, ctx);
  const cookie = await sessionCookie(db, "admin@example.com");
  return { worker, db, env, cookie };
}

function seedAlbum(db) {
  db.prepare("INSERT OR REPLACE INTO surveys (id,name,active) VALUES ('main','הסקר הראשי',1)").run();
  db.prepare("INSERT OR REPLACE INTO poll_settings (id,voting_open) VALUES ('main',0)").run();
  db.prepare("INSERT INTO albums (id,survey_id,title,artist_name,position,active) VALUES ('album-1','main','אלבום','אמן',0,1)").run();
  for (const [index, id] of ["song-a", "song-b", "song-c"].entries()) {
    db.prepare("INSERT INTO songs (id,album_id,title,position,active) VALUES (?,?,?,?,1)").run(id, "album-1", id, index);
  }
}

const songPositions = (db) =>
  Object.fromEntries(db.prepare("SELECT id,position FROM songs WHERE album_id='album-1'").all().map((row) => [row.id, row.position]));

test("reordering songs inside an album persists the new order", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAlbum(db);

  const response = await worker.fetch(new Request("http://localhost/api/admin/reorder", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ kind: "song", ids: ["song-c", "song-a", "song-b"] }),
  }), env, ctx);

  assert.equal(response.status, 200, `שינוי סדר השירים החזיר ${response.status}: ${await response.clone().text()}`);
  assert.deepEqual(songPositions(db), { "song-c": 0, "song-a": 1, "song-b": 2 });
});

test("song order is rejected, not crashed, while the poll is open", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAlbum(db);
  db.prepare("UPDATE poll_settings SET voting_open=1 WHERE id='main'").run();

  const response = await worker.fetch(new Request("http://localhost/api/admin/reorder", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ kind: "song", ids: ["song-c", "song-a", "song-b"] }),
  }), env, ctx);

  // המנהל חייב לקבל את הסיבה, ולא כשל כללי, כדי שידע שצריך לסגור את ההצבעה.
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /לסגור קודם את ההצבעה/);
  assert.deepEqual(songPositions(db), { "song-a": 0, "song-b": 1, "song-c": 2 });
});

test("songs from another album are refused", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAlbum(db);
  db.prepare("INSERT INTO albums (id,survey_id,title,artist_name,position,active) VALUES ('album-2','main','אחר','אמן',1,1)").run();
  db.prepare("INSERT INTO songs (id,album_id,title,position,active) VALUES ('song-d','album-2','song-d',0,1)").run();

  const response = await worker.fetch(new Request("http://localhost/api/admin/reorder", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ kind: "song", ids: ["song-a", "song-d"] }),
  }), env, ctx);

  assert.equal(response.status, 400);
  assert.deepEqual(songPositions(db), { "song-a": 0, "song-b": 1, "song-c": 2 });
});

test("the voters panel lists ballots instead of failing", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAlbum(db);
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('ballot-1','main','voter-1','site',1)").run();
  db.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES ('ballot-1','album-1')").run();
  db.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES ('ballot-1','album-1','song-b')").run();

  const response = await worker.fetch(new Request("http://localhost/api/admin/voters", { headers: { cookie } }), env, ctx);

  assert.equal(response.status, 200, `רשימת המצביעים החזירה ${response.status}: ${await response.clone().text()}`);
  const body = await response.json();
  assert.equal(body.voters.length, 1);
  assert.deepEqual(body.voters[0].albums, ["אלבום"]);
  assert.deepEqual(body.voters[0].songs, [{ title: "song-b", albumTitle: "אלבום" }]);
});
