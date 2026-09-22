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

// חיבור של מצביע רגיל (לא מנהל), כדי לבדוק מה האתר יראה לו לפני ואחרי איפוס.
async function voterCookie(db, sub, email) {
  const token = `voter-token-${sub}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
    .run(hash, sub, email, "מצביע", null, Math.floor(Date.now() / 1000) + 3600);
  return `rosh_session=${token}`;
}

const resetVoter = (worker, env, cookie, payload) =>
  worker.fetch(new Request("http://localhost/api/admin/voters/reset", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(payload) }), env, ctx);

test("an administrator can reset a voter by email so they can vote again", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAlbum(db);
  const fingerprint = "b".repeat(64);
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,voter_email,channel,fingerprint,created_at) VALUES ('ballot-reset','main','google-sub-7','voter@example.com','site',?,1)").run(fingerprint);
  db.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES ('ballot-reset','album-1')").run();
  db.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES ('ballot-reset','album-1','song-a')").run();
  db.prepare("INSERT INTO blocked_fingerprints (survey_id,fingerprint,blocked_by) VALUES ('main',?,'admin@example.com')").run(fingerprint);
  db.prepare("INSERT INTO site_ballot_progress (survey_id,user_sub,data_json) VALUES ('main','google-sub-7','{}')").run();
  const voter = await voterCookie(db, "google-sub-7", "voter@example.com");
  const check = () => worker.fetch(new Request(`http://localhost/api/ballots/check?fingerprint=${fingerprint}`, { headers: { cookie: voter } }), env, ctx).then((r) => r.json());
  assert.equal((await check()).voted, true);

  // הכתובת מנורמלת: רווחים ואותיות גדולות אינם מונעים את הזיהוי.
  const response = await resetVoter(worker, env, cookie, { email: " Voter@Example.com " });
  assert.equal(response.status, 200, `איפוס המצביע החזיר ${response.status}: ${await response.clone().text()}`);
  assert.deepEqual(await response.json(), { ok: true, deleted: 1, unblocked: 1 });
  for (const table of ["ballots", "album_votes", "song_votes", "blocked_fingerprints", "site_ballot_progress"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total, 0, `${table} עדיין מכילה שורות`);
  }
  // האתר שואל את השרת בכל כניסה, ולכן המצביע רואה מיד שהוא יכול להצביע.
  assert.deepEqual(await check(), { voted: false });

  const again = await resetVoter(worker, env, cookie, { email: "voter@example.com" });
  assert.equal(again.status, 404);
});

test("resetting by email also finds an old ballot that kept only the Google subject", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAlbum(db);
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('ballot-old','main','google-sub-9','site',1)").run();
  await voterCookie(db, "google-sub-9", "old@example.com");

  const response = await resetVoter(worker, env, cookie, { email: "old@example.com" });
  assert.equal(response.status, 200, `איפוס לפי כתובת ישנה החזיר ${response.status}: ${await response.clone().text()}`);
  assert.deepEqual(await response.json(), { ok: true, deleted: 1, unblocked: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM ballots").get().total, 0);
});

test("resetting one voter by phone or ballot id leaves the other ballots in place", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAlbum(db);
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('ballot-phone','main','0501234567','phone',1)").run();
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,voter_email,channel,created_at) VALUES ('ballot-other','main','google-sub-2','other@example.com','site',2)").run();

  assert.equal((await resetVoter(worker, env, cookie, {})).status, 400);
  const byPhone = await resetVoter(worker, env, cookie, { email: "050-123-4567" });
  assert.equal(byPhone.status, 200);
  assert.deepEqual(db.prepare("SELECT id FROM ballots ORDER BY id").all().map((row) => row.id), ["ballot-other"]);
  const byId = await resetVoter(worker, env, cookie, { ballotId: "ballot-other" });
  assert.equal(byId.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM ballots").get().total, 0);
});

test("resetting a voter requires an administrator", async () => {
  const { worker, db, env } = await setup();
  seedAlbum(db);
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,voter_email,channel,created_at) VALUES ('ballot-keep','main','google-sub-3','keep@example.com','site',1)").run();
  const voter = await voterCookie(db, "google-sub-3", "keep@example.com");
  const response = await resetVoter(worker, env, voter, { email: "keep@example.com" });
  assert.equal(response.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM ballots").get().total, 1);
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
  // לאלבום ב אין אף קול מהטלפון, ולכן אין לו מקום בטלפון — אחרת ערוץ ריק
  // היה מחלק מקומות לכולם והטבלה הייתה מסמנת פער בין הערוצים משום מקום.
  assert.equal(albumRank[1].phonePlace, 0, "an item with no votes in a channel has no place in that channel");
  assert.equal(albumRank[2].sitePlace, 0, "and the same on the site side");

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

test("the advanced-data endpoint reports pace, activity by local hour, the rank race, concentration and abandoned ballots", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAnalytics(db);
  // סקר קודם, כדי שההשוואה בין סקרים תהיה על נתונים אמיתיים.
  db.prepare("INSERT INTO surveys (id,name,active,created_at) VALUES ('old','מצעד קודם',0,1)").run();
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('old-1','old','voter-b1','site',500000)").run();
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('old-2','old','voter-old','site',500100)").run();
  // טיוטות שנטושות באתר: ההתקדמות נמחקת בשליחה, ולכן שורה שנשארה נטושה.
  db.prepare("INSERT INTO site_ballot_progress (survey_id,user_sub,data_json,updated_at) VALUES ('main','draft-1','{\"stageIndex\":1,\"albumIds\":[\"a1\"]}',1000500)").run();
  db.prepare("INSERT INTO site_ballot_progress (survey_id,user_sub,data_json,updated_at) VALUES ('main','draft-2','{\"stageIndex\":1}',1000600)").run();
  db.prepare("INSERT INTO site_ballot_progress (survey_id,user_sub,data_json,updated_at) VALUES ('main','draft-3','{\"stageIndex\":3}',1000700)").run();
  // נרשם לרשימת התפוצה שגם הצביע באתר בסקר הזה.
  db.prepare("INSERT INTO subscribers (id,email,user_sub,source,created_at) VALUES ('sub-1','a@example.com','voter-b1','site',1)").run();
  db.prepare("INSERT INTO subscribers (id,email,user_sub,source,created_at) VALUES ('sub-2','b@example.com','nobody','site',1)").run();

  const response = await worker.fetch(new Request("http://localhost/api/admin/analytics", { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200, `הנתונים המתקדמים החזירו ${response.status}: ${await response.clone().text()}`);
  const body = await response.json();

  // הפעילות מסודרת לפי שעון ישראל, ולכן סכום התאים שווה לסך ההצבעות.
  const activityTotal = body.activity.cells.flat().reduce((sum, value) => sum + value, 0);
  assert.equal(activityTotal, 3, "every ballot lands in exactly one weekday-hour cell");
  assert.equal(body.activity.cells.length, 7);
  assert.equal(body.activity.cells[0].length, 24);
  assert.equal(body.activity.site.flat().reduce((sum, value) => sum + value, 0), 2);
  assert.equal(body.activity.phone.flat().reduce((sum, value) => sum + value, 0), 1);
  assert.ok(body.daily.peakHour && body.daily.peakHour.votes >= 1);

  assert.deepEqual(body.pace.windows.map((window) => window.label), ["השעה האחרונה", "24 השעות האחרונות", "שבעת הימים האחרונים"]);
  assert.equal(body.pace.windows[0].votes, 0, "the seeded ballots are decades old, so the recent windows are empty");
  assert.ok(body.pace.quietHours > 0, "the panel can say how long the poll has been silent");

  // מרוץ הדירוג: מצטבר לכל יום, לא ספירה יומית.
  const leader = body.race.albums[0];
  assert.equal(leader.title, "אלבום א");
  assert.equal(leader.points.length, body.daily.series.length);
  assert.deepEqual(leader.points.map((point) => point.cumulative), [2, 3], "the cumulative line never goes down");

  assert.ok(body.concentration.albums.index > 0 && body.concentration.albums.index <= 100);
  assert.equal(body.concentration.albums.itemsForHalf, 1, "one album already holds half the album votes");
  assert.equal(body.concentration.albums.topFiveShare, 100);
  assert.ok(["none", "weak", "clear"].includes(body.positionBias.albums.verdict));

  assert.equal(body.abandoned.siteTotal, 3);
  assert.deepEqual(body.abandoned.site.map((row) => [row.stage, row.count]), [[1, 2], [3, 1]]);
  assert.equal(body.abandoned.site[0].label, "בחירת שירים");
  assert.equal(body.abandoned.phoneTotal, 0, "no phone drafts in the object store fake");
  assert.equal(body.abandoned.completionRate, 50, "three finished ballots out of six that were started");

  assert.equal(body.returning.voters, 1, "voter-b1 also voted in the older survey");
  assert.equal(body.returning.previous.id, "old");
  assert.equal(body.returning.previous.total, 2);
  assert.equal(typeof body.returning.previous.atSameElapsed, "number");

  assert.equal(body.subscribers.total, 2);
  assert.equal(body.subscribers.fromThisSurvey, 1);
  assert.equal(body.subscribers.share, 50, "one of the two site voters is on the mailing list");

  // b3 בחר את אלבום א ושיר מתוכו, ולכן אין נשירה בין השלבים.
  assert.deepEqual(body.stageDropoff, [], "every album vote here is backed by a song vote");
});

test("identical album combinations are counted as one however the ballot ordered them", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAnalytics(db);
  // אותו זוג אלבומים, בסדר הפוך בטבלה — חייב להיספר כשילוב אחד.
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('b4','main','voter-b4','site',1000400)").run();
  db.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES ('b4','a2')").run();
  db.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES ('b4','a1')").run();

  const response = await worker.fetch(new Request("http://localhost/api/admin/analytics", { headers: { cookie } }), env, ctx);
  const body = await response.json();
  const pair = body.combos.top.find((combo) => combo.albums.length === 2);
  assert.equal(pair.votes, 3, "three ballots hold the same two albums, whatever order they were inserted in");
  assert.equal(body.combos.distinct, 2, "that pair and the single-album ballot");
});

test("a ballot cannot file one song under several albums to multiply its vote", async () => {
  const { worker, db, env, cookie } = await setup();
  seedAnalytics(db);
  // s1 שייך ל-a1 בלבד. פתק ששולח אותו גם תחת a2 היה כותב שתי שורות
  // ב-song_votes, ושתיהן חוקיות מול האינדקס הייחודי (ballot, album, song).
  const response = await worker.fetch(new Request("http://localhost/api/ballots", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ivr-secret": "secret" },
    body: JSON.stringify({ voterKey: "0500000009", channel: "phone", albumIds: ["a1", "a2"], songIdsByAlbum: { a1: ["s1"], a2: ["s1"] }, artistIds: ["r1"] }),
  }), { ...env, IVR_SECRET: "secret" }, ctx);

  assert.equal(response.status, 400, "a song filed under an album it does not belong to is refused");
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM ballots WHERE voter_key='0500000009'").get().total, 0, "nothing is written for a refused ballot");

  // וגם אם שורות כאלה כבר יושבות במסד מלפני התיקון, הספירה היא לפי פתקים.
  db.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,created_at) VALUES ('legacy','main','voter-legacy','site',1000450)").run();
  db.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES ('legacy','a1')").run();
  db.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES ('legacy','a2')").run();
  db.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES ('legacy','a1','s1')").run();
  db.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES ('legacy','a2','s1')").run();

  const analytics = await (await worker.fetch(new Request("http://localhost/api/admin/analytics", { headers: { cookie } }), env, ctx)).json();
  const song = analytics.rankings.songs.find((item) => item.id === "s1");
  assert.equal(song.votes, 3, "two seeded ballots plus the legacy one count once each, not four times");
  assert.ok(song.votes <= analytics.totals.ballots, "a song can never hold more votes than there are ballots");

  const overview = await (await worker.fetch(new Request("http://localhost/api/admin/overview", { headers: { cookie } }), env, ctx)).json();
  assert.equal(overview.results.songs.find((item) => item.id === "s1").votes, 3, "the results tab agrees with the advanced-data tab");
});
