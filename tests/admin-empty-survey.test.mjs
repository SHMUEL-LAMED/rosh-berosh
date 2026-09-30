import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * ריקון הסקר ופינוי האחסון, מקצה לקצה על הוורקר הבנוי: SQLite אמיתי במקום D1 ואחסון בזיכרון במקום R2.
 * התוכן והקבצים של הסקר נמחקים, ההצבעות נשמרות בארכיון בלי קבצים, ומה שעדיין בשימוש נשאר.
 */

function d1(db) {
  const statement = (sql, values = []) => ({
    bind: (...next) => statement(sql, next),
    async all() {
      const prepared = db.prepare(sql);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { results: prepared.all(...values), success: true };
      const info = prepared.run(...values);
      return { results: [], success: true, meta: { changes: Number(info.changes) } };
    },
    async first(column) {
      const row = db.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] : row;
    },
    async run() { return this.all(); },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) { const out = []; for (const item of statements) out.push(await item.all()); return out; },
  };
}

/** R2 בזיכרון: מספיק למה שהוורקר עושה כאן */
function r2() {
  const objects = new Map();
  const body = (value) => ({ body: value, httpMetadata: {}, customMetadata: {}, async text() { return typeof value === "string" ? value : new TextDecoder().decode(value); } });
  return {
    objects,
    async get(key) { return objects.has(key) ? body(objects.get(key)) : null; },
    async put(key, value) { objects.set(key, typeof value === "string" ? value : "binary"); },
    async delete(keys) { for (const key of [].concat(keys)) objects.delete(key); },
    async list({ prefix = "", limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit);
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
  };
}

async function setup() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  const db = new DatabaseSync(":memory:");
  const media = r2();
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  await worker.fetch(new Request("http://localhost/api/admin/overview"), env, ctx);   // בונה את הסכמה
  const token = "test-session-token";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)").run(hash, "sub-1", "admin@example.com", "מנהל", null, Math.floor(Date.now() / 1000) + 3600);
  const empty = () => worker.fetch(new Request("http://localhost/api/admin/empty-survey", { method: "POST", headers: { cookie: `rosh_session=${token}` } }), env, ctx);
  return { db, media, empty };
}

function seed(db, media) {
  const file = (key) => { media.objects.set(key, "binary"); return `/media/${key}`; };
  db.prepare("INSERT OR REPLACE INTO surveys (id,name,active) VALUES ('main','הסקר',1)").run();
  db.prepare("INSERT OR REPLACE INTO surveys (id,name,active) VALUES ('old','סקר ישן',0)").run();
  db.prepare("INSERT OR REPLACE INTO poll_settings (id,voting_open) VALUES ('main',0)").run();
  db.prepare("INSERT OR REPLACE INTO poll_settings (id,voting_open) VALUES ('old',0)").run();
  const shared = file("albums/a1/cover-shared.jpg");                       // גם סקר אחר משתמש בה — נשארת
  db.prepare("INSERT INTO albums (id,survey_id,title,artist_name,cover_url,position,active) VALUES ('a1','main','אלבום','אמן',?,0,1)").run(shared);
  db.prepare("INSERT INTO albums (id,survey_id,title,artist_name,cover_url,position,active) VALUES ('a2','main','שני','אמן',?,1,1)").run(file("albums/a2/cover.jpg"));
  db.prepare("INSERT INTO songs (id,album_id,title,audio_url,cover_url,position,active) VALUES ('s1','a1','שיר',?,?,0,1)").run(file("albums/a1/audio-1.mp3"), file("albums/a1/cover-s1.jpg"));
  db.prepare("INSERT INTO songs (id,album_id,title,audio_url,position,active) VALUES ('s2','a2','שיר ב',?,0,1)").run(file("albums/a2/audio-2.mp3"));
  db.prepare("INSERT INTO artists (id,survey_id,name,image_url,position,active) VALUES ('r1','main','זמר',?,0,1)").run(file("artists/r1/image.jpg"));
  file("albums/gone/audio-left-behind.mp3");                               // שארית ממחיקה קודמת — נמחקת
  file("restored/x/leftover.jpg");                                          // שארית משחזור — נמחקת
  db.prepare("INSERT INTO albums (id,survey_id,title,artist_name,cover_url,position,active) VALUES ('o1','old','ישן','אמן',?,0,1)").run(shared);
  db.prepare("INSERT INTO ivr_prompts (key,label,audio_url,yemot_path,updated_at) VALUES ('album:a1','אלבום',?, '',0)").run(file("ivr-prompts/album-a1-tts.mp3"));
  db.prepare("INSERT INTO ivr_prompts (key,label,audio_url,yemot_path,updated_at) VALUES ('welcome','ברוכים הבאים',?, '',0)").run(file("ivr-prompts/welcome.mp3"));
  file("program/ep1/recording.mp3");                                        // אתר התוכניות — לא נוגעים
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('b1','main','v1','site',1)").run();
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('b2','main','v2','phone',2)").run();
  db.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES ('b1','a1'),('b2','a2')").run();
  db.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES ('b1','a1','s1')").run();
  db.prepare("INSERT INTO artist_votes (ballot_id,artist_id) VALUES ('b1','r1')").run();
}

const count = (db, sql) => db.prepare(sql).get().n;

test("emptying the survey deletes its content and files, and keeps the votes in the archive", async () => {
  const { db, media, empty } = await setup();
  seed(db, media);

  const response = await empty();
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.albums, 2);
  assert.equal(result.songs, 2);
  assert.equal(result.artists, 1);
  assert.equal(result.votes, 2);

  // התוכן וההצבעות ירדו מהסקר הפעיל; הסקר הישן לא נפגע
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM albums WHERE survey_id='main'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM songs"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM artists"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM ballots WHERE survey_id='main'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM albums WHERE survey_id='old'"), 1);
  // קריינות הפריט נמחקה, הודעת המערכת נשארה
  assert.deepEqual(db.prepare("SELECT key FROM ivr_prompts ORDER BY key").all().map((row) => row.key), ["welcome"]);

  // האחסון: קובצי הסקר והשאריות נמחקו; מה שבשימוש ואתר התוכניות נשארו
  const left = [...media.objects.keys()].filter((key) => !key.startsWith("poll-archives/")).sort();
  assert.deepEqual(left, ["albums/a1/cover-shared.jpg", "ivr-prompts/welcome.mp3", "program/ep1/recording.mp3"]);
  assert.equal(result.files, 8);

  // הארכיון: ההצבעות והשמות, בלי קבצים ובלי אתר התוכניות
  const archiveKeys = [...media.objects.keys()].filter((key) => key.startsWith("poll-archives/"));
  assert.equal(archiveKeys.length, 1, "exactly one archive file, no copied media");
  assert.equal(archiveKeys[0], result.archive.key);
  const snapshot = JSON.parse(media.objects.get(archiveKeys[0]));
  assert.equal(snapshot.ballots.length, 2);
  assert.equal(snapshot.albumVotes.length, 2);
  assert.equal(snapshot.albums.length, 2);
  assert.equal(snapshot.mediaSkipped, true);
  assert.deepEqual(snapshot.media, []);
  assert.equal(snapshot.program, undefined);
});

test("emptying is refused while voting is open, and nothing is touched", async () => {
  const { db, media, empty } = await setup();
  seed(db, media);
  db.prepare("UPDATE poll_settings SET voting_open=1 WHERE id='main'").run();
  const before = media.objects.size;

  const response = await empty();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /לסגור קודם את ההצבעה/);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM albums WHERE survey_id='main'"), 2);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM ballots"), 2);
  assert.equal(media.objects.size, before);
});
