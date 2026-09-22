import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/**
 * אתר התוכניות (rosh-berosh-2) אינו מחזיק רשימת מנהלים משלו: מי שמנהל את אתר
 * הסקר מנהל גם אותו. הבדיקות כאן רצות על הוורקר הבנוי מול SQLite אמיתי
 * ומוודאות שכל מי שמחובר לאתר הסקר מקבל סשן לאתר התוכניות (אזור אישי), ושרק
 * מי שברשימת המנהלים מקבל `isAdmin` וגישה לכתיבה.
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

// טוקן בלי נקודה: טוקן עם נקודה נקרא כאישור Google ישן, לא כסשן שרת.
async function sessionCookie(db, email, token = `session-${email.split("@")[0]}`) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
    .run(hash, `sub-${email}`, email, "משתמש", null, Math.floor(Date.now() / 1000) + 3600);
  return `rosh_session=${token}`;
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const PROGRAM_ORIGIN = "https://shmuel-lamed.github.io";

// רשימת המנהלים של אתר הסקר: משתנה הסביבה ועוד הרשימה שנשמרת ב-R2 מלשונית
// "הרשאות". הרשימה ב-R2 ניתנת לשינוי תוך כדי הבדיקה, כמו הוספה או הסרה באתר.
async function setup({ savedManagers = [] } = {}) {
  const worker = await loadWorker();
  const db = new DatabaseSync(":memory:");
  const media = {
    async get(key) { return key === "settings/admin-emails.json" ? { async json() { return savedManagers; } } : null; },
    async put() {},
    async delete() {},
    async list() { return { objects: [] }; },
  };
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  return { worker, db, env, savedManagers };
}

const exchange = (worker, env, cookie) => worker.fetch(new Request("http://localhost/api/program/auth/session", {
  method: "POST",
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  body: "{}",
}), env, ctx);

const me = (worker, env, token) => worker.fetch(new Request("http://localhost/api/program/me", {
  headers: { authorization: `Bearer ${token}`, origin: PROGRAM_ORIGIN },
}), env, ctx);

test("a voting-site administrator's session is exchanged for a program session", async () => {
  const { worker, db, env } = await setup();
  const cookie = await sessionCookie(db, "admin@example.com");

  const response = await exchange(worker, env, cookie);
  assert.equal(response.status, 200, await response.clone().text());
  const { token, user } = await response.json();
  assert.ok(token && !token.includes("."), "the program token is an opaque server session");
  assert.equal(user.email, "admin@example.com");
  assert.equal(user.isAdmin, true);

  const check = await me(worker, env, token);
  assert.equal(check.status, 200);
  assert.equal((await check.json()).user.isAdmin, true);
  assert.equal(check.headers.get("access-control-allow-origin"), PROGRAM_ORIGIN);

  const renew = await worker.fetch(new Request("http://localhost/api/program/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  }), env, ctx);
  assert.equal(renew.status, 401, "a program token alone cannot mint another program token");
});

test("a manager added in the voting site's permissions tab manages the program site too", async () => {
  const { worker, db, env } = await setup({ savedManagers: ["editor@example.com"] });
  const cookie = await sessionCookie(db, "editor@example.com");
  const response = await exchange(worker, env, cookie);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).user.isAdmin, true);
});

test("a signed-in voter who is not a manager gets a personal session without management", async () => {
  const { worker, db, env } = await setup();
  const cookie = await sessionCookie(db, "voter@example.com");
  const response = await exchange(worker, env, cookie);
  assert.equal(response.status, 200, await response.clone().text());
  const { token, user } = await response.json();
  assert.ok(token && !token.includes("."));
  assert.equal(user.email, "voter@example.com");
  assert.equal(user.isAdmin, false, "everyone signs in; only the admin list grants management");

  const check = await me(worker, env, token);
  assert.equal(check.status, 200);
  assert.equal((await check.json()).user.isAdmin, false);

  const write = await worker.fetch(new Request("http://localhost/api/program/catalog", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: PROGRAM_ORIGIN },
    body: JSON.stringify({ seasons: [], episodes: [] }),
  }), env, ctx);
  assert.equal(write.status, 403, "a listener's session cannot publish");
});

test("without a voting-site session there is nothing to exchange", async () => {
  const { worker, env } = await setup();
  const response = await exchange(worker, env, null);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), null, "the exchange is same-origin only");
});

test("removing a manager on the voting site locks the program site at once", async () => {
  const { worker, db, env, savedManagers } = await setup({ savedManagers: ["temp@example.com"] });
  const cookie = await sessionCookie(db, "temp@example.com");
  const { token } = await (await exchange(worker, env, cookie)).json();
  assert.equal((await me(worker, env, token)).status, 200);

  savedManagers.length = 0;
  const demoted = await me(worker, env, token);
  assert.equal(demoted.status, 200, "the session itself survives");
  assert.equal((await demoted.json()).user.isAdmin, false, "but management is gone at once");
  const write = await worker.fetch(new Request("http://localhost/api/program/catalog", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: PROGRAM_ORIGIN },
    body: JSON.stringify({ seasons: [], episodes: [] }),
  }), env, ctx);
  assert.equal(write.status, 403);
});

test("the login window hands a signed-in administrator straight through and keeps Google for everyone else", async () => {
  const { worker, db, env } = await setup();
  const cookie = await sessionCookie(db, "admin@example.com");

  const asAdmin = await worker.fetch(new Request("http://localhost/api/program/login", { headers: { cookie } }), env, ctx);
  assert.equal(asAdmin.status, 200);
  const adminHtml = await asAdmin.text();
  assert.match(adminHtml, /const known=\{"email":"admin@example\.com","isAdmin":true\}/);
  assert.match(adminHtml, /\/api\/program\/auth\/session/);
  assert.match(adminHtml, /מחוברים לאתר הסקר כ־/);

  const anonymous = await worker.fetch(new Request("http://localhost/api/program/login"), env, ctx);
  const anonymousHtml = await anonymous.text();
  assert.match(anonymousHtml, /const known=null;/);
  assert.match(anonymousHtml, /accounts\.google\.com\/gsi\/client/);
  assert.match(anonymous.headers.get("content-security-policy"), /style-src 'unsafe-inline' https:\/\/accounts\.google\.com\/gsi\/style/);

  const voterCookie = await sessionCookie(db, "voter@example.com");
  const asVoter = await worker.fetch(new Request("http://localhost/api/program/login", { headers: { cookie: voterCookie } }), env, ctx);
  const voterHtml = await asVoter.text();
  assert.match(voterHtml, /const known=\{"email":"voter@example\.com","isAdmin":false\}/);
  assert.match(voterHtml, /if\(known\)\{/, "a signed-in voter is handed a personal session, not turned away");
  assert.doesNotMatch(voterHtml, /אינו מוגדר שם כמנהל/);
});

/**
 * ההקלטות שמורות בקובצי דרייב משותפים. גוגל מגיש אותם כאודיו עם Range לשרתים,
 * אבל עונה 403 לכל בקשת דפדפן חוצת־אתרים (Sec-Fetch-Site: cross-site), ולכן
 * הנגן של אתר התוכניות מזרים אותם דרך הוורקר: /api/program/stream/<מזהה>.
 */
function withDrive(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://drive.usercontent.google.com/download?")) return original(input, init);
    const headers = new Headers(init.headers || (typeof input === "string" ? {} : input.headers));
    return handler(new URL(url), headers, init.method || "GET");
  };
  return () => { globalThis.fetch = original; };
}
const AUDIO_BYTES = new Uint8Array(85_228_622 % 1000 + 1000).fill(73);
const driveOk = (url, headers, method) => {
  assert.equal(url.searchParams.get("export"), "download");
  assert.equal(url.searchParams.get("confirm"), "t");
  assert.equal(headers.get("sec-fetch-site"), null, "a server fetch carries no browser fetch metadata");
  const range = headers.get("range");
  const match = range?.match(/^bytes=(\d+)-(\d*)$/);
  if (match) {
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : AUDIO_BYTES.length - 1;
    return new Response(method === "HEAD" ? null : AUDIO_BYTES.slice(start, end + 1), { status: 206, headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${AUDIO_BYTES.length}`, "content-length": String(end - start + 1), "accept-ranges": "bytes", "content-disposition": "attachment; filename=\"x.mp3\"" } });
  }
  return new Response(method === "HEAD" ? null : AUDIO_BYTES, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(AUDIO_BYTES.length), "accept-ranges": "bytes", "content-disposition": "attachment; filename=\"x.mp3\"" } });
};
const stream = (worker, env, id, init = {}) => worker.fetch(new Request(`http://localhost/api/program/stream/${id}`, { headers: { origin: PROGRAM_ORIGIN, ...init.headers }, method: init.method || "GET" }), env, ctx);

test("a Drive recording streams through the worker with ranges and without Google's own pages", async () => {
  const { worker, env } = await setup();
  const restore = withDrive(driveOk);
  try {
    const whole = await stream(worker, env, "1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4");
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "audio/mpeg");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.equal(whole.headers.get("content-disposition"), "inline", "played in the site's player, not downloaded");
    assert.equal(whole.headers.get("access-control-allow-origin"), PROGRAM_ORIGIN);
    assert.match(whole.headers.get("access-control-expose-headers"), /content-range/);
    assert.deepEqual(new Uint8Array(await whole.arrayBuffer()), AUDIO_BYTES);

    const part = await stream(worker, env, "1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4", { headers: { range: "bytes=100-199" } });
    assert.equal(part.status, 206, "seeking passes the Range header straight through");
    assert.equal(part.headers.get("content-range"), `bytes 100-199/${AUDIO_BYTES.length}`);
    assert.equal(part.headers.get("content-length"), "100");
    assert.equal((await part.arrayBuffer()).byteLength, 100);

    const head = await stream(worker, env, "1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "audio/mpeg");
    assert.equal(await head.text(), "");
  } finally { restore(); }
});

test("the stream endpoint refuses bad ids and never relays Google's HTML", async () => {
  const { worker, env } = await setup();
  assert.equal((await stream(worker, env, "1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4.mp3")).status, 400, "only a bare file id, nothing that could reach another path");
  assert.equal((await stream(worker, env, "short")).status, 400);
  const restore = withDrive(() => new Response("<html>Error 403</html>", { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }));
  try {
    const blocked = await stream(worker, env, "1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4");
    assert.equal(blocked.status, 502);
    assert.match(blocked.headers.get("content-type"), /application\/json/);
    assert.match((await blocked.json()).error, /אינה זמינה/);
  } finally { restore(); }
  const restoreHtml = withDrive(() => new Response("<html>virus scan warning</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
  try {
    const page = await stream(worker, env, "1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4");
    assert.equal(page.status, 502, "an HTML interstitial is not audio");
  } finally { restoreHtml(); }
});
