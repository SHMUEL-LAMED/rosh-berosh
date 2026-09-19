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

test("the voters panel returns an email instead of the opaque Google subject", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAlbum(db);
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,voter_email,channel,created_at) VALUES ('ballot-email','main','google-sub-123','voter@example.com','site',1)").run();
  const response = await worker.fetch(new Request("http://localhost/api/admin/voters", { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.voters[0].voterEmail, "voter@example.com");
});

test("an administrator can block and unblock a suspicious computer", async () => {
  const { worker, db, env, cookie } = await setup();
  const fingerprint = "a".repeat(64);
  const block = await worker.fetch(new Request("http://localhost/api/admin/blocked-fingerprints", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ fingerprint }) }), env, ctx);
  assert.equal(block.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM blocked_fingerprints WHERE fingerprint=?").get(fingerprint).total, 1);
  const unblock = await worker.fetch(new Request("http://localhost/api/admin/blocked-fingerprints", { method: "DELETE", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ fingerprint }) }), env, ctx);
  assert.equal(unblock.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM blocked_fingerprints WHERE fingerprint=?").get(fingerprint).total, 0);
});

// לשונית "נתונים מתקדמים": ה-SQL רץ מול SQLite אמיתי, כולל הפרמטרים
// הממוספרים (?1), GROUP_CONCAT על תת-שאילתה ממוינת, וההצלבות העצמיות.
function seedAnalytics(db) {
  db.prepare("INSERT OR REPLACE INTO surveys (id,name,active) VALUES ('main','הסקר הראשי',1)").run();
  db.prepare("INSERT OR REPLACE INTO poll_settings (id,voting_open,albums_min,albums_max,songs_min,songs_max,artists_min,artists_max) VALUES ('main',1,1,2,1,1,1,2)").run();
  db.prepare("INSERT INTO albums (id,survey_id,title,artist_name,cover_url,position,active) VALUES ('a1','main','אלבום א','ישי ריבו','https://x/cover.jpg',0,1)").run();
  db.prepare("INSERT INTO albums (id,survey_id,title,artist_name,position,active) VALUES ('a2','main','אלבום ב','אמן אחר',1,1)").run();
  db.prepare("INSERT INTO albums (id,survey_id,title,artist_name,position,active) VALUES ('a3','main','אלבום ג','שלישי',2,1)").run();
  db.prepare("INSERT INTO songs (id,album_id,title,audio_url,preview_start,preview_end,position,active) VALUES ('s1','a1','שיר 1','https://x/s1.mp3',10,40,0,1)").run();
  db.prepare("INSERT INTO songs (id,album_id,title,audio_url,preview_start,preview_end,position,active) VALUES ('s2','a1','שיר 2','https://x/s2.mp3',0,0,1,1)").run();
  db.prepare("INSERT INTO songs (id,album_id,title,position,active) VALUES ('s3','a2','שיר 3',0,1)").run();
  db.prepare("INSERT INTO artists (id,survey_id,name,position,active) VALUES ('r1','main','ישי ריבו',0,1)").run();
  db.prepare("INSERT INTO artists (id,survey_id,name,position,active) VALUES ('r2','main','זמר שני',1,1)").run();
  const ballot = (id, channel, createdAt, timing = []) => {
    db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at,started_at,albums_done_at,songs_done_at,artists_done_at,sessions) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, "main", `voter-${id}`, channel, createdAt, ...(timing.length ? timing : [null, null, null, null, null]));
  };
  ballot("b1", "site", 1_000_100, [1_000_000, 1_000_020, 1_000_050, 1_000_080, 1]);
  ballot("b2", "site", 1_000_300, [1_000_000, 1_000_100, 1_000_200, 1_000_250, 2]);
  ballot("b3", "phone", 1_090_000);
  for (const [ballotId, albums, songs, artists] of [["b1", ["a1", "a2"], { a1: "s1", a2: "s3" }, ["r1", "r2"]], ["b2", ["a1", "a2"], { a1: "s1", a2: "s3" }, ["r1"]], ["b3", ["a1"], { a1: "s2" }, ["r2"]]]) {
    for (const albumId of albums) db.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES (?,?)").run(ballotId, albumId);
    for (const [albumId, songId] of Object.entries(songs)) db.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES (?,?,?)").run(ballotId, albumId, songId);
    for (const artistId of artists) db.prepare("INSERT INTO artist_votes (ballot_id,artist_id) VALUES (?,?)").run(ballotId, artistId);
  }
}

test("the advanced-data endpoint computes breakdowns, crosses, timing and content status from real rows", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAnalytics(db);
  const response = await worker.fetch(new Request("http://localhost/api/admin/analytics", { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200, `הנתונים המתקדמים החזירו ${response.status}: ${await response.clone().text()}`);
  const body = await response.json();

  assert.deepEqual({ ballots: body.totals.ballots, site: body.totals.site, phone: body.totals.phone }, { ballots: 3, site: 2, phone: 1 });

  const first = body.albumBreakdown.find((album) => album.id === "a1");
  assert.equal(first.topSong.title, "שיר 1");
  assert.equal(first.topSong.share, 66.7);
  assert.deepEqual(body.zeroVotes.albums.map((item) => item.title), ["אלבום ג"]);

  const albumRank = body.rankings.albums;
  assert.deepEqual(albumRank.map((item) => [item.place, item.title, item.votes, item.site, item.phone]), [[1, "אלבום א", 3, 2, 1], [2, "אלבום ב", 2, 2, 0], [3, "אלבום ג", 0, 0, 0]]);
  assert.equal(albumRank[1].gapAbove, 1, "votes separating second place from first");
  assert.equal(albumRank[0].phonePlace, 1);
  assert.equal(albumRank[1].phonePlace, 2, "ties share the same phone place");

  const rivo = body.artistAlbums.find((artist) => artist.id === "r1");
  assert.equal(rivo.top[0].title, "אלבום א");
  assert.equal(rivo.own[0].title, "אלבום א", "an album whose artist field names the singer is his own");
  assert.equal(rivo.own[0].ofArtistVoters, 100);
  assert.deepEqual(body.artistPairs[0], { a: "ישי ריבו", b: "זמר שני", votes: 1, shareOfA: 50, shareOfB: 50 });
  assert.equal(body.albumCompanions.find((album) => album.id === "a1").top[0].title, "אלבום ב");

  assert.equal(body.combos.top[0].votes, 2, "two identical album pairs");
  assert.deepEqual(body.combos.top[0].albums, ["אלבום א", "אלבום ב"]);
  assert.equal(body.combos.repeated, 2);

  assert.equal(body.timing.all.overall.count, 2);
  assert.equal(body.timing.all.overall.median, 200);
  assert.equal(body.timing.all.overall.total, 400, "total time everybody spent");
  assert.equal(body.timing.site.stages.albums.median, 60);
  assert.equal(body.timing.site.stages.summary.median, 35);
  assert.equal(body.timing.phone.overall.count, 0);
  assert.equal(body.timing.untracked, 1);
  assert.deepEqual(body.timing.all.sessions.map((bucket) => bucket.count), [1, 1, 0]);

  assert.equal(body.daily.series.length, 2);
  assert.equal(body.daily.series[1].cumulative, 3);

  assert.deepEqual(body.content.songsWithoutAudio.map((item) => item.title), ["שיר 3"]);
  assert.deepEqual(body.content.songsWithoutPreview.map((item) => item.title), ["שיר 2"]);
  assert.deepEqual(body.content.albumsWithoutCover.map((item) => item.title), ["אלבום ב", "אלבום ג"]);
  assert.equal(body.content.missingPrompts.length, 8, "no narration exists for any of the 3 albums, 2 artists and 3 songs");
});

test("a ballot submitted with timing keeps it, and a bogus timing is dropped instead of rejected", async () => {
  const { worker, db, env } = await setup();
  seedAnalytics(db);
  const submit = (voterKey, timing) => worker.fetch(new Request("http://localhost/api/ballots", { method: "POST", headers: { "content-type": "application/json", "x-ivr-secret": "secret" }, body: JSON.stringify({ voterKey, channel: "phone", albumIds: ["a2"], songIdsByAlbum: { a2: ["s3"] }, artistIds: ["r2"], timing }) }), { ...env, IVR_SECRET: "secret" }, ctx);
  const now = Math.floor(Date.now() / 1000);
  const good = await submit("0500000001", { startedAt: now - 300, albumsDoneAt: now - 200, songsDoneAt: now - 100, artistsDoneAt: now - 20, sessions: 2 });
  assert.equal(good.status, 201, await good.clone().text());
  const stored = db.prepare("SELECT started_at AS startedAt, sessions FROM ballots WHERE voter_key='0500000001'").get();
  assert.deepEqual({ ...stored }, { startedAt: now - 300, sessions: 2 });
  const bogus = await submit("0500000002", { startedAt: now + 9999, sessions: -4 });
  assert.equal(bogus.status, 201);
  assert.deepEqual({ ...db.prepare("SELECT started_at AS startedAt, sessions FROM ballots WHERE voter_key='0500000002'").get() }, { startedAt: null, sessions: null });
});
