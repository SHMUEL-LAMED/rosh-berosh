import assert from "node:assert/strict";
import test from "node:test";
import { applyRuntimeSchema } from "../worker/schema-statements.js";
import { readIvrCatalog } from "../worker/ivr-catalog.js";

// שיחה נכנסת לקו מחכה לקטלוג הזה לפני שהמתקשר שומע משהו, ולכן נמדד כאן גם
// מה חוזר וגם כמה הליכות אל D1 עלה להביא אותו.
async function sqliteDb(t) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return null; }
  const sqlite = new DatabaseSync(":memory:");
  const trips = { batch: 0, standalone: 0 };
  const run = (sql, args) => {
    const statement = sqlite.prepare(sql);
    return statement.all(...args);
  };
  const db = {
    prepare(sql) {
      const make = (args = []) => ({
        sql,
        args,
        bind: (...next) => make(next),
        async all() { trips.standalone++; return { results: run(sql, args) }; },
        async first() { trips.standalone++; return run(sql, args)[0] ?? null; },
        async run() { trips.standalone++; sqlite.prepare(sql).run(...args); return { success: true }; },
      });
      return make();
    },
    async batch(statements) {
      trips.batch++;
      return statements.map((statement) => ({ results: run(statement.sql, statement.args) }));
    },
  };
  t.after(() => sqlite.close());
  return { db, sqlite, trips };
}

test("the phone catalog comes back whole, in a single database round trip", async (t) => {
  const harness = await sqliteDb(t);
  if (!harness) return t.skip("node:sqlite is unavailable without --experimental-sqlite");
  const { db, sqlite, trips } = harness;
  assert.deepEqual(await applyRuntimeSchema(db), []);

  sqlite.exec(`
    INSERT INTO albums (id, survey_id, title, artist_name, active, position) VALUES
      ('a2', 'main', 'אלבום שני', 'זמר ב', 1, 2),
      ('a1', 'main', 'אלבום ראשון', 'זמר א', 1, 1),
      ('a3', 'main', 'אלבום כבוי', 'זמר ג', 0, 3);
    INSERT INTO songs (id, album_id, title, active, position) VALUES
      ('s2', 'a1', 'שיר שני', 1, 2),
      ('s1', 'a1', 'שיר ראשון', 1, 1),
      ('s3', 'a3', 'שיר של אלבום כבוי', 1, 1);
    INSERT INTO artists (id, survey_id, name, active, position) VALUES
      ('r1', 'main', 'זמר א', 1, 1),
      ('r2', 'main', 'זמר כבוי', 0, 2);
    INSERT INTO ivr_prompts (key, label, audio_url, yemot_path, updated_at) VALUES
      ('system:albums_intro', 'פתיח אלבומים', '/media/intro.wav', 'ivr2:/1/001.wav', 1),
      ('system:unsynced', 'בלי קובץ בימות', '/media/unsynced.wav', '', 2);
    UPDATE poll_settings SET voting_open = 1 WHERE id = 'main';
  `);

  const before = { ...trips };
  const catalog = await readIvrCatalog(db);

  assert.equal(trips.batch - before.batch, 1, "הקטלוג חייב לרוץ בקבוצה אחת");
  assert.equal(trips.standalone - before.standalone, 1, "רק שאילתת הקריינויות רצה לצדה, ובמקביל");

  assert.equal(catalog.surveyId, "main");
  assert.deepEqual(catalog.albums.map((album) => album.id), ["a1", "a2"], "אלבום כבוי אינו מוצע בקו, והסדר לפי position");
  assert.equal(catalog.albums[0].artistName, "זמר א");
  assert.deepEqual(catalog.songs.map((song) => song.id), ["s1", "s2"], "שיר של אלבום כבוי אינו מגיע לקו");
  assert.deepEqual(catalog.artists.map((artist) => artist.id), ["r1"]);
  assert.equal(catalog.rules.votingOpen, 1);
  assert.deepEqual(
    catalog.ivrPrompts.map(({ key, yemotPath }) => ({ key, yemotPath })),
    [{ key: "system:albums_intro", yemotPath: "ivr2:/1/001.wav" }],
    "קריינות בלי קובץ בימות אינה נשלחת לקו",
  );
});

test("a database with no active survey still answers the line instead of failing", async (t) => {
  const harness = await sqliteDb(t);
  if (!harness) return t.skip("node:sqlite is unavailable without --experimental-sqlite");
  const { db, sqlite } = harness;
  assert.deepEqual(await applyRuntimeSchema(db), []);
  sqlite.exec("UPDATE surveys SET active = 0");

  const catalog = await readIvrCatalog(db);
  assert.equal(catalog.surveyId, "main", "ברירת המחדל היא הסקר main, לא undefined");
  assert.deepEqual(catalog.albums, []);
  assert.ok(catalog.rules, "כללי ההצבעה חייבים לחזור גם כשאין סקר פעיל");
});

test("the phone payload carries no website media, so the line downloads nothing it cannot play", async (t) => {
  const harness = await sqliteDb(t);
  if (!harness) return t.skip("node:sqlite is unavailable without --experimental-sqlite");
  const { db, sqlite } = harness;
  assert.deepEqual(await applyRuntimeSchema(db), []);
  sqlite.exec(`
    INSERT INTO albums (id, survey_id, title, artist_name, cover_url, active, position)
      VALUES ('a1', 'main', 'אלבום', 'זמר', '/media/cover.jpg', 1, 1);
    INSERT INTO songs (id, album_id, title, audio_url, active, position)
      VALUES ('s1', 'a1', 'שיר', '/media/song.mp3', 1, 1);
  `);

  const catalog = await readIvrCatalog(db);
  assert.equal(catalog.albums[0].coverUrl, undefined);
  assert.equal(catalog.songs[0].audioUrl, undefined);
});
