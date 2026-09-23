import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { decryptPush, receiverKeys } from "./push-receiver.mjs";

/**
 * התוספות לאתר התוכניות, מול הוורקר הבנוי, SQLite אמיתי ו־R2 מדומה: תוכניות
 * מתוזמנות, הגנה מהתנגשות בפרסום, העלאה בחלקים, הורדה עם שם קובץ, נתונים
 * אישיים, לייקים, התראות דחיפה (כולל ה־cron), סטטיסטיקות מורחבות, תמלול
 * וסיכום, ודף השיתוף /p/<slug>.
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
    async batch(statements) { const out = []; for (const item of statements) out.push(await item.all()); return out; },
  };
}

/** R2 מדומה עם Range והעלאה בחלקים. */
function r2() {
  const objects = new Map();
  const uploads = new Map();
  const bytesOf = async (body) => {
    if (body instanceof Uint8Array) return body;
    if (typeof body === "string") return new TextEncoder().encode(body);
    return new Uint8Array(await new Response(body).arrayBuffer());
  };
  const object = (key, stored, range) => {
    const slice = range ? stored.bytes.slice(range.offset, range.offset + range.length) : stored.bytes;
    return {
      key, size: stored.bytes.length, httpEtag: `"etag-${key}"`, range,
      body: new Response(slice).body,
      writeHttpMetadata(headers) { if (stored.contentType) headers.set("content-type", stored.contentType); },
      async arrayBuffer() { return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength); },
      async json() { return JSON.parse(new TextDecoder().decode(slice)); },
    };
  };
  return {
    objects, uploads,
    async get(key, options = {}) {
      const stored = objects.get(key);
      if (!stored) return null;
      let range = options.range;
      if (range instanceof Headers) {
        const match = range.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
        const start = Number(match[1]), end = match[2] ? Number(match[2]) : stored.bytes.length - 1;
        range = { offset: start, length: end - start + 1 };
      }
      return object(key, stored, range);
    },
    async head(key) { const stored = objects.get(key); return stored ? { key, size: stored.bytes.length } : null; },
    async put(key, body, options = {}) { const bytes = await bytesOf(body); objects.set(key, { bytes, contentType: options.httpMetadata?.contentType }); return { key, size: bytes.length }; },
    async delete(key) { objects.delete(key); },
    async list() { return { objects: [] }; },
    async createMultipartUpload(key, options = {}) {
      const uploadId = `up-${uploads.size + 1}`;
      uploads.set(uploadId, { key, parts: new Map(), contentType: options.httpMetadata?.contentType, state: "open" });
      return { key, uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error("no such upload");
      return {
        async uploadPart(partNumber, body) { upload.parts.set(partNumber, await bytesOf(body)); return { partNumber, etag: `etag-${partNumber}` }; },
        async complete(parts) {
          const bytes = new Uint8Array(parts.reduce((sum, part) => sum + upload.parts.get(part.partNumber).length, 0));
          let offset = 0;
          for (const part of parts) { const chunk = upload.parts.get(part.partNumber); bytes.set(chunk, offset); offset += chunk.length; }
          objects.set(key, { bytes, contentType: upload.contentType });
          upload.state = "complete";
          return { key, size: bytes.length };
        },
        async abort() { upload.state = "aborted"; },
      };
    },
  };
}

async function sessionToken(db, email, token = `tok-${email.split("@")[0]}`) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  db.prepare("INSERT INTO auth_sessions (token_hash,user_sub,email,name,picture,expires_at) VALUES (?,?,?,?,?,?)")
    .run(hash, `sub-${email}`, email, "משתמש", null, Math.floor(Date.now() / 1000) + 3600);
  return token;
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const ORIGIN = "https://shmuel-lamed.github.io";
const FUTURE = "2099-01-01T20:00";
const PAST = "2020-01-01T20:00";

async function setup() {
  const worker = await loadWorker();
  const db = new DatabaseSync(":memory:");
  const media = r2();
  const waits = [];
  const ctx = { waitUntil(promise) { waits.push(promise); }, passThroughOnException() {} };
  const env = { DB: d1(db), MEDIA: media, ADMIN_EMAILS: "admin@example.com", ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  await worker.fetch(new Request("http://localhost/api/program/catalog"), env, ctx);
  const admin = await sessionToken(db, "admin@example.com");
  const voter = await sessionToken(db, "voter@example.com");
  const call = (path, { method = "GET", body, raw, token, ip = "1.2.3.4", headers = {} } = {}) => worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { ...(raw ? {} : { "content-type": "application/json" }), origin: ORIGIN, "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), env, ctx);
  const settle = async () => { while (waits.length) await waits.shift(); };
  return { worker, db, env, media, ctx, admin, voter, call, settle };
}

const episode = (id, extra = {}) => ({ id, slug: id, title: `תוכנית ${id}`, date: "2026-09-01", visible: true, ...extra });
const publish = (call, token, episodes, extra = {}) => call("/api/program/catalog", { method: "POST", token, body: { seasons: [], episodes, ...extra } });

function withFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const answer = await handler(url, init);
    return answer ?? original(input, init);
  };
  return () => { globalThis.fetch = original; };
}

test("a scheduled episode stays hidden from the public until its time, and admins always see it", async () => {
  const { call, admin } = await setup();
  const write = await publish(call, admin, [episode("ep-future", { publishAt: FUTURE }), episode("ep-past", { publishAt: PAST }), episode("ep-now")]);
  assert.equal(write.status, 200, await write.clone().text());
  const ids = (list) => list.episodes.map((item) => item.id);
  const pub = await (await call("/api/program/catalog")).json();
  assert.ok(!ids(pub).includes("ep-future"), "a future publishAt is not public");
  assert.ok(ids(pub).includes("ep-past") && ids(pub).includes("ep-now"));
  assert.equal(pub.versionId, undefined, "the version id is for admins only");
  const own = await (await call("/api/program/catalog", { token: admin })).json();
  assert.ok(ids(own).includes("ep-future"), "admins see scheduled episodes");
  assert.equal((await call("/api/program/download/ep-future")).status, 404, "downloads respect the schedule");
});

test("publishing on top of someone else's publish is refused unless forced", async () => {
  const { call, admin } = await setup();
  const first = await (await publish(call, admin, [episode("ep-1")])).json();
  assert.ok(first.versionId);
  const catalog = await (await call("/api/program/catalog", { token: admin })).json();
  assert.equal(catalog.versionId, first.versionId);

  const second = await (await publish(call, admin, [episode("ep-1")], { baseVersion: first.versionId })).json();
  assert.ok(second.versionId && second.versionId !== first.versionId);

  const stale = await publish(call, admin, [episode("ep-1", { title: "ישן" })], { baseVersion: first.versionId });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.conflict, true);
  assert.match(conflict.error, /מישהו אחר פרסם בינתיים/);
  assert.equal(conflict.latest.id, second.versionId);
  assert.equal(conflict.latest.by, "admin@example.com");
  const after = await (await call("/api/program/catalog", { token: admin })).json();
  assert.equal(after.versionId, second.versionId, "nothing was written");
  assert.notEqual(after.episodes.find((item) => item.id === "ep-1").title, "ישן");

  const forced = await publish(call, admin, [episode("ep-1", { title: "ישן" })], { baseVersion: first.versionId, force: true });
  assert.equal(forced.status, 200);
  const legacy = await publish(call, admin, [episode("ep-1")]);
  assert.equal(legacy.status, 200, "without baseVersion there is no check (older clients)");
});

test("large files upload in parts and are served back with ranges", async () => {
  const { call, admin, voter, media } = await setup();
  assert.equal((await call("/api/program/upload/start?episode=ep-1&kind=audio", { method: "POST", token: voter, body: { contentType: "audio/mpeg", size: 10 } })).status, 403);
  assert.equal((await call("/api/program/upload/start?episode=ep-1&kind=audio", { method: "POST", token: admin, body: { contentType: "text/html", size: 10 } })).status, 400);
  assert.equal((await call("/api/program/upload/start?episode=ep-1&kind=audio", { method: "POST", token: admin, body: { contentType: "audio/mpeg", size: 2 * 1024 ** 3 } })).status, 400);
  assert.equal((await call("/api/program/upload/start?episode=ep-1&kind=cover", { method: "POST", token: admin, body: { contentType: "image/png", size: 20 * 1024 * 1024 } })).status, 400);

  const start = await call("/api/program/upload/start?episode=ep-1&kind=audio", { method: "POST", token: admin, body: { contentType: "audio/mpeg", size: 300, name: "תוכנית.mp3" } });
  assert.equal(start.status, 200, await start.clone().text());
  const { key, uploadId, partSize } = await start.json();
  assert.match(key, /^program\/ep-1\/[\w-]+\.mp3$/);
  assert.equal(partSize, 20971520);

  const put = (part, bytes, k = key) => call(`/api/program/upload/part?key=${encodeURIComponent(k)}&uploadId=${uploadId}&part=${part}`, { method: "PUT", token: admin, raw: bytes, headers: { "content-type": "application/octet-stream" } });
  assert.equal((await put(1, new Uint8Array(1), "settings/admin-emails.json")).status, 400, "only program/ keys");
  assert.equal((await put(1, new Uint8Array(1), "program/../settings/x")).status, 400);
  const one = await (await put(1, new Uint8Array(200).fill(1))).json();
  const two = await (await put(2, new Uint8Array(100).fill(2))).json();
  assert.deepEqual(one, { part: 1, etag: "etag-1" });

  const done = await call("/api/program/upload/complete", { method: "POST", token: admin, body: { key, uploadId, parts: [two, one] } });
  assert.equal(done.status, 200, await done.clone().text());
  const result = await done.json();
  assert.deepEqual(result, { url: `http://localhost/media/${key}`, key, size: 300 });
  assert.equal(media.objects.get(key).bytes[250], 2);

  const ranged = await call(`/media/${key}`, { headers: { range: "bytes=195-204" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 195-204/300");
  assert.equal(ranged.headers.get("content-length"), "10");
  assert.equal(ranged.headers.get("access-control-allow-origin"), "*", "media is readable cross-origin (canvas thumbnails)");
  assert.equal(ranged.headers.get("access-control-expose-headers"), "content-length,content-range,accept-ranges");
  const whole = await call(`/media/${key}`, { method: "HEAD" });
  assert.equal(whole.headers.get("content-length"), "300");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("access-control-allow-origin"), "*");
  const full = await call(`/media/${key}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("access-control-allow-origin"), "*");
  assert.equal(full.headers.get("access-control-expose-headers"), "content-length,content-range,accept-ranges");
  assert.equal(full.headers.get("vary"), null);

  const other = await (await call("/api/program/upload/start?episode=ep-1&kind=cover", { method: "POST", token: admin, body: { contentType: "image/jpeg", size: 100 } })).json();
  assert.match(other.key, /\.jpg$/);
  const abort = await call("/api/program/upload/abort", { method: "POST", token: admin, body: { key: other.key, uploadId: other.uploadId } });
  assert.deepEqual(await abort.json(), { ok: true });
  assert.equal(media.uploads.get(other.uploadId).state, "aborted");

  const preflight = await call("/api/program/upload/part", { method: "OPTIONS" });
  assert.match(preflight.headers.get("access-control-allow-methods"), /PUT/);
});

test("an episode downloads with its Hebrew title as the file name", async () => {
  const { call, admin, media } = await setup();
  await media.put("program-recordings/abc.mp3", new Uint8Array(1000).fill(5), { httpMetadata: { contentType: "audio/mpeg" } });
  await publish(call, admin, [
    episode("ep-dl", { title: "ראש בראש: מיוחד/חג", r2Key: "program-recordings/abc.mp3" }),
    episode("ep-media", { title: "Special Show", audio: "http://localhost/media/program/ep-media/x.m4a" }),
    episode("ep-drive", { audio: "https://drive.google.com/file/d/1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4/view" }),
    episode("ep-none"),
    episode("ep-hidden", { visible: false, r2Key: "program-recordings/abc.mp3" }),
  ]);
  await media.put("program/ep-media/x.m4a", new Uint8Array(50), { httpMetadata: { contentType: "audio/mp4" } });

  const response = await call("/api/program/download/ep-dl");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("content-length"), "1000");
  const disposition = response.headers.get("content-disposition");
  assert.match(disposition, /^attachment; filename="rosh-berosh-ep-dl\.mp3"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), "ראש בראש מיוחד חג.mp3");
  assert.match(response.headers.get("access-control-expose-headers"), /content-disposition/);
  assert.equal((await response.arrayBuffer()).byteLength, 1000);

  const part = await call("/api/program/download/ep-dl", { headers: { range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 0-99/1000");

  const media2 = await call("/api/program/download/ep-media", { method: "HEAD" });
  assert.equal(media2.status, 200);
  assert.match(media2.headers.get("content-disposition"), /filename="Special Show\.m4a"/);

  const drive = await call("/api/program/download/ep-drive");
  assert.equal(drive.status, 302);
  assert.match(drive.headers.get("location"), /drive\.usercontent\.google\.com\/download\?id=1zYtLR6CVkcM4mQZJ1fmf56jrLe1lBJy4/);

  assert.equal((await call("/api/program/download/ep-none")).status, 404);
  assert.equal((await call("/api/program/download/ep-hidden")).status, 404);
  assert.equal((await call("/api/program/download/ep-hidden", { token: admin })).status, 200, "admins download hidden episodes");
});

test("personal data syncs per account", async () => {
  const { call, voter, admin } = await setup();
  assert.equal((await call("/api/program/userdata")).status, 401);
  assert.deepEqual(await (await call("/api/program/userdata", { token: voter })).json(), { data: null, updatedAt: null });
  assert.equal((await call("/api/program/userdata", { method: "PUT", token: voter, body: { data: [1, 2] } })).status, 400);
  assert.equal((await call("/api/program/userdata", { method: "PUT", token: voter, body: { data: { big: "x".repeat(310 * 1024) } } })).status, 413);
  const saved = await (await call("/api/program/userdata", { method: "PUT", token: voter, body: { data: { favorites: ["ep-1"], positions: { "ep-1": 120 } } } })).json();
  assert.equal(saved.ok, true);
  assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)));
  const read = await (await call("/api/program/userdata", { token: voter })).json();
  assert.deepEqual(read.data, { favorites: ["ep-1"], positions: { "ep-1": 120 } });
  assert.equal(read.updatedAt, saved.updatedAt);
  assert.deepEqual((await (await call("/api/program/userdata", { token: admin })).json()).data, null, "another account sees its own data only");
  assert.deepEqual(await (await call("/api/program/userdata", { method: "DELETE", token: voter })).json(), { ok: true });
  assert.equal((await (await call("/api/program/userdata", { token: voter })).json()).data, null);
});

test("likes are counted per episode and appear in the stats", async () => {
  const { call, voter, admin } = await setup();
  await publish(call, admin, [episode("ep-1"), episode("ep-2")]);
  assert.equal((await call("/api/program/likes", { method: "POST", body: { episodeId: "ep-1", like: true } })).status, 401);
  // כמה אהבו — רק מנהלים מקבלים את המספר, גם בתשובה לסימון עצמו
  assert.deepEqual(await (await call("/api/program/likes", { method: "POST", token: voter, body: { episodeId: "ep-1", like: true } })).json(), { ok: true, liked: true });
  assert.deepEqual(await (await call("/api/program/likes", { method: "POST", token: admin, body: { episodeId: "ep-1", like: true } })).json(), { ok: true, liked: true, count: 2 });
  await call("/api/program/likes", { method: "POST", token: voter, body: { episodeId: "ep-1", like: true } });
  assert.equal((await call("/api/program/likes", { method: "POST", token: voter, body: { episodeId: "nope", like: true } })).status, 404);
  // כמה אהבו — רק מנהלים רואים; מאזין רואה רק את הסימונים שלו
  const pub = await (await call("/api/program/likes")).json();
  assert.deepEqual(pub, { counts: {}, mine: [] });
  assert.deepEqual(await (await call("/api/program/likes", { token: voter })).json(), { counts: {}, mine: ["ep-1"] });
  assert.deepEqual((await (await call("/api/program/likes", { token: admin })).json()).counts, { "ep-1": 2 });
  assert.deepEqual(await (await call("/api/program/likes", { method: "POST", token: voter, body: { episodeId: "ep-1", like: false } })).json(), { ok: true, liked: false });
  const stats = await (await call("/api/program/stats", { token: admin })).json();
  assert.deepEqual(stats.likes, [{ id: "ep-1", likes: 1 }]);
});

test("listening events carry position and source, and the stats show sources, hours and retention", async () => {
  const { call, admin } = await setup();
  const send = (body, ip) => call("/api/program/events", { method: "POST", body, ip });
  assert.equal((await send({ kind: "play", episodeId: "ep-1", ref: "whatsapp" }, "10.0.0.1")).status, 200);
  await send({ kind: "listen", episodeId: "ep-1", seconds: 120, pct: 42.6 }, "10.0.0.1");
  await send({ kind: "listen", episodeId: "ep-1", seconds: 120, pct: 97 }, "10.0.0.1");
  await send({ kind: "play", episodeId: "ep-1", ref: "tiktok" }, "10.0.0.2");
  await send({ kind: "listen", episodeId: "ep-1", seconds: 60, pct: 12 }, "10.0.0.2");
  await send({ kind: "play", episodeId: "ep-1", ref: "google" }, "10.0.0.3");
  await send({ kind: "listen", episodeId: "ep-1", pct: 250 }, "10.0.0.3");
  await send({ kind: "play", episodeId: "ep-2", ref: "email" }, "10.0.0.4");

  const stats = await (await call("/api/program/stats", { token: admin })).json();
  const sources = Object.fromEntries(stats.sources.map((row) => [row.ref, row.plays]));
  assert.deepEqual(sources, { whatsapp: 1, other: 1, google: 1, email: 1 }, "an unknown source becomes other; the mailing-list email is its own source");
  assert.equal(stats.hours.length, 24);
  assert.deepEqual(stats.hours.map((row) => row.hour), Array.from({ length: 24 }, (_, i) => i));
  assert.equal(stats.hours.reduce((sum, row) => sum + row.plays, 0), 4);

  assert.equal((await call("/api/program/stats/episode/ep-1")).status, 403);
  const detail = await (await call("/api/program/stats/episode/ep-1", { token: admin })).json();
  assert.equal(detail.id, "ep-1");
  assert.equal(detail.plays, 3);
  assert.equal(detail.listeners, 3);
  assert.equal(detail.retention.length, 20);
  const at = (pct) => detail.retention.find((row) => row.pct === pct).listeners;
  assert.equal(at(0), 3);
  assert.equal(at(10), 3);
  assert.equal(at(15), 2, "12% does not reach 15%");
  assert.equal(at(95), 2, "97% and the clamped 100%");
});

test("push subscriptions receive admin messages and publish notifications; dead ones are removed", async () => {
  const { call, admin, voter, settle, db } = await setup();
  const key = await (await call("/api/program/push/key")).json();
  assert.match(key.publicKey, /^[\w-]{87}$/);
  assert.equal((await (await call("/api/program/push/key")).json()).publicKey, key.publicKey, "the keys are generated once");

  const alive = await receiverKeys();
  const dead = await receiverKeys();
  const subscribe = (endpoint, keys, token, ip) => call("/api/program/push/subscribe", { method: "POST", token, ip, body: { subscription: { endpoint, keys: { p256dh: keys.subscription.p256dh, auth: keys.subscription.auth } } } });
  assert.equal((await subscribe("http://fcm.googleapis.com/fcm/send/a", alive, null, "9.9.9.1")).status, 400, "https only");
  assert.equal((await subscribe("https://fcm.googleapis.com/fcm/send/alive", alive, voter, "9.9.9.2")).status, 200);
  assert.equal((await subscribe("https://fcm.googleapis.com/fcm/send/dead", dead, null, "9.9.9.3")).status, 200);
  assert.equal(db.prepare("SELECT user_sub FROM program_push WHERE endpoint='https://fcm.googleapis.com/fcm/send/alive'").get().user_sub, "sub-voter@example.com");
  assert.equal((await call("/api/program/push/count")).status, 403);
  assert.deepEqual(await (await call("/api/program/push/count", { token: admin })).json(), { total: 2 });

  const received = [];
  const restore = withFetch(async (url, init) => {
    if (!url.startsWith("https://fcm.googleapis.com/")) return null;
    const headers = new Headers(init.headers);
    assert.match(headers.get("authorization"), new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${key.publicKey}$`));
    assert.equal(headers.get("content-encoding"), "aes128gcm");
    assert.equal(headers.get("ttl"), "86400");
    assert.equal(headers.get("urgency"), "normal");
    if (url.endsWith("/dead")) return new Response(null, { status: 410 });
    received.push(JSON.parse(await decryptPush(new Uint8Array(init.body), alive)));
    return new Response(null, { status: 201 });
  });
  try {
    const sent = await (await call("/api/program/push/send", { method: "POST", token: admin, body: { title: "שידור חי", body: "עכשיו באוויר", url: "https://shmuel-lamed.github.io/rosh-berosh-2/" } })).json();
    assert.deepEqual(sent, { queued: true, sent: 1, failed: 0, removed: 1, remaining: 0, total: 2 });
    assert.deepEqual(received[0], { title: "שידור חי", body: "עכשיו באוויר", url: "https://shmuel-lamed.github.io/rosh-berosh-2/", icon: "https://shmuel-lamed.github.io/rosh-berosh-2/assets/img/icon-192.png" });
    assert.deepEqual(await (await call("/api/program/push/count", { token: admin })).json(), { total: 1 });

    // פרסום עם notify רק מכניס לתור; דף הניהול מרוקן אותו בלולאה, כמו drainPush בלקוח
    const drain = async () => { for (let i = 0; i < 10; i += 1) if (!(await (await call("/api/program/push/drain", { method: "POST", token: admin })).json()).remaining) break; };
    received.length = 0;
    await publish(call, admin, [episode("ep-old")]);
    await settle();
    await drain();
    assert.equal(received.length, 0, "no notification without notify");
    const notifying = await (await publish(call, admin, [episode("ep-old"), episode("ep-new", { number: 12, title: "חדשה" }), episode("ep-later", { publishAt: FUTURE })], { notify: true })).json();
    assert.equal(notifying.notified, 1);
    await settle();
    assert.equal(received.length, 0, "the publish request itself sends nothing");
    await drain();
    assert.equal(received.length, 1, "only the newly public episode, not the old or the scheduled one");
    assert.equal(received[0].body, "תוכנית 12 · חדשה");
    assert.equal(received[0].url, "https://shmuel-lamed.github.io/rosh-berosh-2/episode.html?ep=ep-new");

    received.length = 0;
    await publish(call, admin, [1, 2, 3, 4].map((n) => episode(`ep-batch-${n}`)), { notify: true });
    await settle();
    await drain();
    assert.equal(received.length, 1, "more than three new episodes send one summary");
    assert.equal(received[0].body, "4 תוכניות חדשות באתר");

    assert.deepEqual(await (await call("/api/program/push/unsubscribe", { method: "POST", body: { endpoint: "https://fcm.googleapis.com/fcm/send/alive" } })).json(), { ok: true });
    assert.deepEqual(await (await call("/api/program/push/count", { token: admin })).json(), { total: 0 });
  } finally { restore(); }
});

test("push fan-out is batched: at most 25 sends per invocation, the rest through drain and the cron", async () => {
  const { worker, env, call, admin, db } = await setup();
  const receiver = await receiverKeys();
  const insert = db.prepare("INSERT INTO program_push (endpoint,p256dh,auth) VALUES (?,?,?)");
  for (let i = 0; i < 95; i += 1) insert.run(`https://push.example.com/s${String(i).padStart(3, "0")}`, receiver.subscription.p256dh, receiver.subscription.auth);
  const hits = [];
  let perCall = 0;
  const restore = withFetch(async (url) => {
    if (!url.startsWith("https://push.example.com/")) return null;
    hits.push(url);
    perCall += 1;
    return new Response(null, { status: url.endsWith("s050") ? 410 : 201 });
  });
  const measure = async (run) => { perCall = 0; const result = await run(); assert.ok(perCall <= 25, `${perCall} pushes in one invocation`); return result; };
  try {
    assert.equal((await call("/api/program/push/drain")).status, 404, "POST only");
    assert.equal((await call("/api/program/push/drain", { method: "POST" })).status, 403);
    const first = await measure(async () => (await call("/api/program/push/send", { method: "POST", token: admin, body: { title: "א", body: "ב" } })).json());
    assert.deepEqual(first, { queued: true, sent: 25, failed: 0, removed: 0, remaining: 70, total: 95 });
    const second = await measure(async () => (await call("/api/program/push/drain", { method: "POST", token: admin })).json());
    assert.deepEqual(second, { sent: 25, failed: 0, removed: 0, remaining: 45 });
    const third = await measure(async () => (await call("/api/program/push/drain", { method: "POST", token: admin })).json());
    assert.deepEqual(third, { sent: 24, failed: 0, removed: 1, remaining: 20 });
    const fourth = await measure(async () => (await call("/api/program/push/drain", { method: "POST", token: admin })).json());
    assert.deepEqual(fourth, { sent: 20, failed: 0, removed: 0, remaining: 0 });
    assert.equal(new Set(hits).size, 95, "every subscription exactly once, none skipped by the removal");
    assert.equal(hits.length, 95);
    assert.deepEqual(await (await call("/api/program/push/drain", { method: "POST", token: admin })).json(), { sent: 0, failed: 0, removed: 0, remaining: 0 });

    // שתי הודעות בתור: ה־cron ממשיך לרוקן, 25 בכל ריצה
    hits.length = 0;
    await call("/api/program/push/send", { method: "POST", token: admin, body: { title: "1" } });
    await call("/api/program/push/send", { method: "POST", token: admin, body: { title: "2" } });
    assert.equal(hits.length, 50);
    const queue = JSON.parse(db.prepare("SELECT value_json FROM program_settings WHERE key='push-pending'").get().value_json);
    assert.equal(queue.length, 2);
    const cron = () => measure(async () => {
      const waits = [];
      await worker.scheduled({ cron: "*/5 * * * *" }, env, { waitUntil: (promise) => waits.push(promise), passThroughOnException() {} });
      await Promise.all(waits);
    });
    for (let i = 0; i < 6; i += 1) await cron();
    assert.equal(hits.length, 94 * 2, "both messages reached all 94 remaining subscriptions");
    assert.deepEqual(JSON.parse(db.prepare("SELECT value_json FROM program_settings WHERE key='push-pending'").get().value_json), []);
  } finally { restore(); }
});

test("the cron notifies about scheduled episodes once their time comes, and never about old ones", async () => {
  const { worker, env, call, admin, db } = await setup();
  const receiver = await receiverKeys();
  const subscribed = await call("/api/program/push/subscribe", { method: "POST", ip: "8.8.8.8", body: { subscription: { endpoint: "https://web.push.apple.com/x", keys: { p256dh: receiver.subscription.p256dh, auth: receiver.subscription.auth } } } });
  assert.equal(subscribed.status, 200, await subscribed.clone().text());
  const received = [];
  const restore = withFetch(async (url, init) => {
    if (!url.startsWith("https://web.push.apple.com/")) return null;
    received.push(JSON.parse(await decryptPush(new Uint8Array(init.body), receiver)));
    return new Response(null, { status: 201 });
  });
  const cron = async () => {
    const waits = [];
    await worker.scheduled({ cron: "*/5 * * * *" }, env, { waitUntil: (promise) => waits.push(promise), passThroughOnException() {} });
    await Promise.all(waits);
  };
  try {
    // תוכנית ישנה עם מועד פרסום שעבר — קיימת לפני הריצה הראשונה, ולכן לא תודיע לעולם
    db.prepare("UPDATE program_episodes SET data_json=json_set(data_json,'$.publishAt',?) WHERE id=(SELECT id FROM program_episodes LIMIT 1)").run(PAST);
    await cron();
    assert.equal(received.length, 0, "the first run only seeds");
    const seeded = JSON.parse(db.prepare("SELECT value_json FROM program_settings WHERE key='push-notified'").get().value_json);
    assert.ok(seeded.length >= 80, "every public episode is recorded as already announced");

    await publish(call, admin, [episode("ep-sched", { publishAt: FUTURE, title: "מתוזמנת" })]);
    await cron();
    assert.equal(received.length, 0, "not yet");
    // מגיע המועד
    db.prepare("UPDATE program_episodes SET data_json=json_set(data_json,'$.publishAt',?) WHERE id='ep-sched'").run(PAST);
    await cron();
    assert.equal(received.length, 1);
    assert.equal(received[0].body, "מתוזמנת");
    await cron();
    assert.equal(received.length, 1, "announced once");
  } finally { restore(); }
});

test("transcripts are made in 2MB parts and summarized, for admins only", async () => {
  const { call, env, admin, voter, media } = await setup();
  const size = 2 * 1024 * 1024 * 2 + 100;
  await media.put("program-recordings/long.mp3", new Uint8Array(size), { httpMetadata: { contentType: "audio/mpeg" } });
  await publish(call, admin, [episode("ep-ai", { r2Key: "program-recordings/long.mp3" })]);
  const calls = [];
  env.AI = {
    async run(model, input) {
      calls.push({ model, input });
      if (model.includes("whisper")) {
        if (input.audio === "fail") throw new Error("boom");
        return { text: `חלק ${calls.filter((item) => item.model.includes("whisper")).length}` };
      }
      return { response: 'הנה: ```json\n{"description":"תיאור מזמין.","summary":"• פינה ראשונה\\n• פינה שנייה","tags":["מוזיקה","אקטואליה"],"guests":[]}\n```' };
    },
  };
  assert.equal((await call("/api/program/ai/transcribe", { method: "POST", token: voter, body: { episodeId: "ep-ai", part: 0 } })).status, 403);
  assert.equal((await call("/api/program/ai/summarize", { method: "POST", token: admin, body: { episodeId: "ep-ai" } })).status, 409, "needs a finished transcript");

  const parts = [];
  for (let part = 0; part < 3; part += 1) {
    const response = await call("/api/program/ai/transcribe", { method: "POST", token: admin, body: { episodeId: "ep-ai", part } });
    assert.equal(response.status, 200, await response.clone().text());
    parts.push(await response.json());
  }
  assert.deepEqual(parts.map((item) => [item.part, item.partsTotal, item.done]), [[0, 3, false], [1, 3, false], [2, 3, true]]);
  assert.equal(calls[0].model, "@cf/openai/whisper-large-v3-turbo");
  assert.equal(calls[0].input.language, "he");
  assert.equal(Buffer.from(calls[0].input.audio, "base64").length, 2 * 1024 * 1024);
  assert.equal(Buffer.from(calls[2].input.audio, "base64").length, 100);

  const transcript = await (await call("/api/program/ai/transcript/ep-ai", { token: admin })).json();
  assert.equal(transcript.text, "חלק 1 חלק 2 חלק 3");
  assert.equal(transcript.partsDone, 3);
  assert.equal(transcript.partsTotal, 3);
  assert.equal(transcript.summary, null);

  const summary = await call("/api/program/ai/summarize", { method: "POST", token: admin, body: { episodeId: "ep-ai" } });
  assert.equal(summary.status, 200, await summary.clone().text());
  const parsed = await summary.json();
  assert.equal(parsed.description, "תיאור מזמין.");
  assert.equal(parsed.summary, "• פינה ראשונה\n• פינה שנייה");
  assert.deepEqual(parsed.tags, ["מוזיקה", "אקטואליה"]);
  assert.equal(calls.at(-1).model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.deepEqual((await (await call("/api/program/ai/transcript/ep-ai", { token: admin })).json()).summary.tags, ["מוזיקה", "אקטואליה"]);

  // עם מפתח Claude — הסיכום עובר ל־Anthropic
  env.ANTHROPIC_API_KEY = "sk-test";
  let sent = null;
  const restore = withFetch(async (url, init) => {
    if (url !== "https://api.anthropic.com/v1/messages") return null;
    sent = { headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return Response.json({ content: [{ type: "text", text: '{"description":"מ־Claude","summary":"• א","tags":["ב"],"guests":["אורח"]}' }], stop_reason: "end_turn" });
  });
  try {
    const claude = await (await call("/api/program/ai/summarize", { method: "POST", token: admin, body: { episodeId: "ep-ai" } })).json();
    assert.equal(claude.description, "מ־Claude");
    assert.deepEqual(claude.guests, ["אורח"]);
    assert.equal(sent.headers.get("x-api-key"), "sk-test");
    assert.equal(sent.headers.get("anthropic-version"), "2023-06-01");
    assert.match(sent.body.messages[0].content, /חלק 1 חלק 2 חלק 3/);
  } finally { restore(); }

  env.AI.run = async () => { throw new Error("AI down"); };
  const failed = await call("/api/program/ai/transcribe", { method: "POST", token: admin, body: { episodeId: "ep-ai", part: 0 } });
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /התמלול נכשל/);

  const pub = await (await call("/api/program/catalog")).json();
  assert.doesNotMatch(JSON.stringify(pub), /חלק 1/, "transcripts never reach the public catalog");
});

test("new recordings transcribe in the scheduled job without a manager click", async () => {
  const { worker, db, env, media, admin, call, settle, ctx } = await setup();
  const key = "program-recordings/auto.mp3";
  await media.put(key, new Uint8Array(2 * 1024 * 1024 + 20), { httpMetadata: { contentType: "audio/mpeg" } });
  env.AI = { async run() { return { text: "טקסט מההקלטה" }; } };
  const saved = await publish(call, admin, [episode("auto", { r2Key: key })]);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM program_transcription_jobs WHERE episode_id='auto'").get().n, 1);
  for (let i = 0; i < 2; i += 1) {
    await worker.scheduled({}, env, ctx);
    await settle();
  }
  const transcript = await (await call("/api/program/ai/transcript/auto", { token: admin })).json();
  assert.equal(transcript.partsDone, 2);
  assert.equal(transcript.text, "טקסט מההקלטה טקסט מההקלטה");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM program_transcription_jobs WHERE episode_id='auto'").get().n, 0);
  await publish(call, admin, [episode("auto", { r2Key: key })]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM program_transcription_jobs WHERE episode_id='auto'").get().n, 0, "publishing the same recording does not restart transcription");
});

/** אישור Google חתום (RS256) עם מפתח שנוצר לבדיקה, ו־JWKS תואם להגשה במקום googleapis */
async function googleCredential({ email = "listener@example.com", sub = "sub-google-1" } = {}) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = part({ alg: "RS256", kid: "kid-test" });
  const body = part({ sub, email, email_verified: true, name: "מאזין", aud: "601586229891-tv0i3h3m526m9l0clffqghkspjptt2s2.apps.googleusercontent.com", iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600 });
  const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`))).toString("base64url");
  return { credential: `${head}.${body}.${signature}`, jwks: { keys: [{ ...jwk, kid: "kid-test", alg: "RS256", use: "sig" }] } };
}

test("when the session database is down, sign-in and session reads say 503 'unavailable', never 401 'signed out'", async () => {
  const { worker, env, ctx, call } = await setup();
  const { credential, jwks } = await googleCredential();
  const restore = withFetch(async (url) => (url.startsWith("https://www.googleapis.com/oauth2/v3/certs") ? Response.json(jwks) : undefined));
  try {
    const ok = await call("/api/program/auth/google", { method: "POST", body: { credential } });
    assert.equal(ok.status, 200, await ok.clone().text());
    const { token } = await ok.json();
    assert.ok(token);

    // המסד נופל (למשל המכסה היומית נגמרה): כל שאילתה נכשלת
    const boom = async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit"); };
    const statement = { bind: () => statement, all: boom, first: boom, run: boom };
    env.DB.prepare = () => statement;
    env.DB.batch = boom;

    const down = await call("/api/program/auth/google", { method: "POST", body: { credential } });
    assert.equal(down.status, 503, "Google accepted the credential; only the session write failed");
    assert.equal(down.headers.get("access-control-allow-origin"), ORIGIN, "the program site can read the answer");
    assert.match((await down.json()).error, /לא זמין/);
    const bad = await call("/api/program/auth/google", { method: "POST", body: { credential: "a.b.c" } });
    assert.equal(bad.status, 401, "a rejected Google credential is still 401");

    const me = await call("/api/program/me", { token });
    assert.equal(me.status, 503, "a valid token during an outage is not 'signed out'");
    assert.equal(me.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal((await call("/api/program/userdata", { token })).status, 503);

    const voting = await worker.fetch(new Request("http://localhost/api/auth/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) }), env, ctx);
    assert.equal(voting.status, 503);
    const votingMe = await worker.fetch(new Request("http://localhost/api/auth/me", { headers: { cookie: `rosh_session=${token}` } }), env, ctx);
    assert.equal(votingMe.status, 503);

    // ניווטים של דף שלם חוזרים לאתר במקום להיתקע על JSON של שגיאה
    const sso = await call(`/api/program/sso?return=${encodeURIComponent("https://shmuel-lamed.github.io/rosh-berosh-2/me.html")}`, { token });
    assert.equal(sso.status, 302);
    assert.match(sso.headers.get("location"), /[?&]sso=none/);
    const handoff = await call(`/api/program/handoff/some-code?return=${encodeURIComponent("https://shmuel-lamed.github.io/rosh-berosh-2/me.html")}`);
    assert.equal(handoff.status, 302);
    assert.match(handoff.headers.get("location"), /^https:\/\/shmuel-lamed\.github\.io\/rosh-berosh-2\/me\.html/);
  } finally { restore(); }
  assert.equal((await call("/api/maintenance/vote-reset-status-20260923")).status, 404, "the public diagnostic that scanned the database is gone");
});

test("the share page gives crawlers Open Graph tags and sends people to the episode", async () => {
  const { call, admin } = await setup();
  await publish(call, admin, [
    episode("ep-share", { number: 7, title: "שירים <b>\"חדשים\"</b>", description: "תיאור ".repeat(60), cover: "https://img.example.com/c.jpg" }),
    episode("ep-plain", { title: "בלי עטיפה", cover: "/media/x.jpg" }),
    episode("ep-soon", { publishAt: FUTURE }),
  ]);
  const page = await call("/p/ep-share?t=95");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("cache-control"), "public, max-age=300");
  const html = await page.text();
  assert.match(html, /<html lang="he" dir="rtl">/);
  assert.match(html, /<title>שירים &lt;b&gt;&quot;חדשים&quot;&lt;\/b&gt; — ראש בראש<\/title>/);
  assert.doesNotMatch(html, /<b>"חדשים"/, "everything is escaped");
  assert.match(html, /<meta property="og:title" content="תוכנית 7 · שירים &lt;b&gt;/);
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:site_name" content="ראש בראש">/);
  assert.match(html, /<meta property="og:locale" content="he_IL">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/img\.example\.com\/c\.jpg">/);
  assert.doesNotMatch(html, /og:image:width/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta property="og:url" content="http:\/\/localhost\/p\/ep-share\?t=95">/);
  const description = html.match(/<meta name="description" content="([^"]*)">/)[1];
  assert.ok(description.length <= 200);
  assert.match(html, /<link rel="canonical" href="https:\/\/shmuel-lamed\.github\.io\/rosh-berosh-2\/episode\.html\?ep=ep-share">/);
  assert.match(html, /<meta http-equiv="refresh" content="0;url=https:\/\/shmuel-lamed\.github\.io\/rosh-berosh-2\/episode\.html\?ep=ep-share&amp;t=95">/);
  assert.match(html, /location\.replace\("https:\/\/shmuel-lamed\.github\.io\/rosh-berosh-2\/episode\.html\?ep=ep-share&t=95"\)/);

  const plain = await (await call("/p/ep-plain")).text();
  assert.match(plain, /og:image" content="https:\/\/shmuel-lamed\.github\.io\/rosh-berosh-2\/assets\/img\/og-default\.png"/);
  assert.match(plain, /og:image:width" content="1200"/);
  assert.match(plain, /og:image:height" content="630"/);
  assert.match(plain, /og:title" content="בלי עטיפה"/);

  for (const path of ["/p/ep-soon", "/p/missing"]) {
    const missing = await call(path);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /url=https:\/\/shmuel-lamed\.github\.io\/rosh-berosh-2\//);
  }
});

test("spelling fixes reach episodes already in the database, once, without touching later edits", async () => {
  const { db, call } = await setup();
  const fixes = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../worker/program-text-fixes.json", import.meta.url), "utf8"));
  const [a, b] = fixes.filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i).slice(0, 2);
  assert.ok(a && b && a.id !== b.id, "the fixes list covers at least two episodes");
  const row = (id) => JSON.parse(db.prepare("SELECT data_json FROM program_episodes WHERE id=?").get(id).data_json);
  // מצב כמו בשרת החי: הטקסט המקורי עם השגיאות, ומנהל שכבר ערך תוכנית אחת בעצמו
  const put = (id, data) => db.prepare("UPDATE program_episodes SET data_json=? WHERE id=?").run(JSON.stringify(data), id);
  put(a.id, { ...row(a.id), [a.field]: a.from });
  put(b.id, { ...row(b.id), [b.field]: "נוסח שמנהל כתב בעצמו" });
  db.prepare("INSERT INTO program_settings (key,value_json) VALUES ('draft',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
    .run(JSON.stringify({ data: { seasons: [], episodes: [{ id: a.id, [a.field]: a.from }] }, updatedAt: "x", by: "admin@example.com" }));
  db.prepare("DELETE FROM program_settings WHERE key='program-text-fixes-v1'").run();

  const catalog = await (await call("/api/program/catalog")).json();
  assert.equal(catalog.episodes.find((e) => e.id === a.id)[a.field], a.to, "the original text is corrected");
  assert.equal(row(b.id)[b.field], "נוסח שמנהל כתב בעצמו", "an admin's own edit is left alone");
  const draft = JSON.parse(db.prepare("SELECT value_json FROM program_settings WHERE key='draft'").get().value_json);
  assert.equal(draft.data.episodes[0][a.field], a.to, "the shared draft is corrected too");

  // רץ פעם אחת בלבד: טקסט ישן שמוחזר אחר כך (למשל בשחזור גרסה) לא "מתוקן" שוב בלי ידיעה
  put(a.id, { ...row(a.id), [a.field]: a.from });
  await call("/api/program/catalog");
  assert.equal(row(a.id)[a.field], a.from);
});

test("a malformed episode is refused with 400 before anything is written, and an empty number stays empty", async () => {
  const { call, admin, db } = await setup();
  for (const bad of [[null], [episode("ep-ok"), { id: "ep-x", slug: "ep-x", title: "  " }], [episode("ep-ok"), 5], [{ title: "בלי מזהה" }]]) {
    const response = await publish(call, admin, bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal((await response.json()).error, "נתוני התוכניות אינם תקינים.");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM program_episodes WHERE id='ep-ok'").get().n, 0, "nothing was written");
  const write = await publish(call, admin, [episode("ep-n1", { number: null }), episode("ep-n2", { number: "" }), episode("ep-n3", { number: "12" }), episode("ep-n4", { number: "abc" })]);
  assert.equal(write.status, 200, await write.clone().text());
  const numbers = Object.fromEntries(db.prepare("SELECT id, number FROM program_episodes WHERE id LIKE 'ep-n%'").all().map((row) => [row.id, row.number]));
  assert.deepEqual(numbers, { "ep-n1": null, "ep-n2": null, "ep-n3": 12, "ep-n4": null }, "no episode silently becomes number 0");
});

test("slugs can be swapped between episodes or reused from a removed one; a real duplicate is a 409", async () => {
  const { call, admin, db } = await setup();
  await publish(call, admin, [episode("ep-a", { slug: "foo" }), episode("ep-b", { slug: "bar" })]);
  const slugs = () => Object.fromEntries(db.prepare("SELECT id, slug FROM program_episodes WHERE id IN ('ep-a','ep-b','ep-c','ep-d')").all().map((row) => [row.id, row.slug]));
  const swap = await publish(call, admin, [episode("ep-a", { slug: "bar" }), episode("ep-b", { slug: "foo" })]);
  assert.equal(swap.status, 200, await swap.clone().text());
  assert.deepEqual(slugs(), { "ep-a": "bar", "ep-b": "foo" });
  // מחיקת תוכנית והעברת הכתובת שלה לתוכנית חדשה, באותו פרסום
  const reuse = await publish(call, admin, [episode("ep-b", { slug: "foo" }), episode("ep-c", { slug: "bar" })], { removedIds: ["ep-a"] });
  assert.equal(reuse.status, 200, await reuse.clone().text());
  assert.deepEqual(slugs(), { "ep-b": "foo", "ep-c": "bar" });
  const duplicate = await publish(call, admin, [episode("ep-d", { slug: "foo" })]);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "כתובת כפולה: foo" });
  const twice = await publish(call, admin, [episode("ep-d", { slug: "same" }), episode("ep-e", { slug: "same" })]);
  assert.equal(twice.status, 409);
  assert.deepEqual(slugs(), { "ep-b": "foo", "ep-c": "bar" }, "nothing was written");
});

test("push subscriptions are accepted only from browser push services, and at most 10 per account", async () => {
  const { call, voter, db } = await setup();
  const keys = await receiverKeys();
  const subscribe = (endpoint, ip, token) => call("/api/program/push/subscribe", { method: "POST", ip, token, body: { subscription: { endpoint, keys: { p256dh: keys.subscription.p256dh, auth: keys.subscription.auth } } } });
  let n = 0;
  for (const endpoint of ["https://push.example.com/x", "https://evil.example/fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://notpush.apple.com/x", "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x", "https://127.0.0.1/x"]) {
    assert.equal((await subscribe(endpoint, `7.7.7.${n++}`)).status, 400, endpoint);
  }
  for (const endpoint of ["https://fcm.googleapis.com/fcm/send/a", "https://web.push.apple.com/b", "https://api.push.apple.com/c", "https://wns2-par02p.notify.windows.com/w/?token=d", "https://updates.push.services.mozilla.com/wpush/v2/e", "https://eu.push.samsungosp.com/f"]) {
    assert.equal((await subscribe(endpoint, `7.7.8.${n++}`)).status, 200, endpoint);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM program_push").get().n, 6);
  for (let i = 0; i < 12; i += 1) assert.equal((await subscribe(`https://fcm.googleapis.com/fcm/send/device-${String(i).padStart(2, "0")}`, `7.7.9.${i}`, voter)).status, 200);
  const mine = db.prepare("SELECT endpoint FROM program_push WHERE user_sub='sub-voter@example.com'").all().map((row) => row.endpoint);
  assert.equal(mine.length, 10, "an account keeps its 10 newest devices");
  assert.ok(mine.includes("https://fcm.googleapis.com/fcm/send/device-11"));
  assert.ok(!mine.includes("https://fcm.googleapis.com/fcm/send/device-00"), "the oldest one made room");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM program_push").get().n, 16, "anonymous subscriptions are untouched");
});

/** D1 שכל קריאה אליו מחכה לסבב הבא של לולאת האירועים, כמו קריאת רשת — כך בקשות במקביל באמת משתלבות זו בזו. */
function slowD1(inner) {
  const pause = () => new Promise((resolve) => setImmediate(resolve));
  const wrap = (statement) => ({
    inner: statement,
    bind: (...values) => wrap(statement.bind(...values)),
    async all() { await pause(); return statement.all(); },
    async first(column) { await pause(); return statement.first(column); },
    async run() { await pause(); return statement.run(); },
  });
  return { prepare: (sql) => wrap(inner.prepare(sql)), async batch(list) { await pause(); return inner.batch(list.map((item) => item.inner)); } };
}

test("drains running at the same moment never send the same batch twice", async () => {
  const { call, admin, db, env } = await setup();
  env.DB = slowD1(env.DB);
  const receiver = await receiverKeys();
  const insert = db.prepare("INSERT INTO program_push (endpoint,p256dh,auth) VALUES (?,?,?)");
  for (let i = 0; i < 60; i += 1) insert.run(`https://fcm.googleapis.com/fcm/send/c${String(i).padStart(3, "0")}`, receiver.subscription.p256dh, receiver.subscription.auth);
  db.prepare("INSERT INTO program_settings (key,value_json) VALUES ('push-pending',?)")
    .run(JSON.stringify([{ id: "job-1", payload: { title: "א", body: "ב", url: "https://shmuel-lamed.github.io/rosh-berosh-2/", icon: "" }, cursor: "", createdAt: new Date().toISOString() }]));
  const hits = [];
  const restore = withFetch(async (url) => {
    if (!url.startsWith("https://fcm.googleapis.com/")) return null;
    hits.push(url);
    return new Response(null, { status: 201 });
  });
  try {
    const drain = async () => (await call("/api/program/push/drain", { method: "POST", token: admin })).json();
    // כמו דף הניהול וה־cron שמרוקנים יחד: כל מנה נתפסת פעם אחת בלבד
    await Promise.all([drain(), drain(), drain()]);
    for (let i = 0; i < 5 && (await drain()).remaining; i += 1) { /* משלימים מה שנשאר */ }
    assert.equal(new Set(hits).size, hits.length, "no subscription got the same message twice");
    assert.equal(hits.length, 60, "and none was skipped");
  } finally { restore(); }
});

test("publishing with notify off keeps the cron from announcing the scheduled episodes in it", async () => {
  const { worker, env, call, admin, db } = await setup();
  const receiver = await receiverKeys();
  await call("/api/program/push/subscribe", { method: "POST", ip: "8.8.4.4", body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/q", keys: { p256dh: receiver.subscription.p256dh, auth: receiver.subscription.auth } } } });
  const received = [];
  const restore = withFetch(async (url, init) => {
    if (!url.startsWith("https://fcm.googleapis.com/")) return null;
    received.push(JSON.parse(await decryptPush(new Uint8Array(init.body), receiver)));
    return new Response(null, { status: 201 });
  });
  const cron = async () => {
    const waits = [];
    await worker.scheduled({ cron: "*/5 * * * *" }, env, { waitUntil: (promise) => waits.push(promise), passThroughOnException() {} });
    await Promise.all(waits);
  };
  try {
    await cron();
    await publish(call, admin, [episode("ep-quiet", { publishAt: FUTURE })], { notify: false });
    await publish(call, admin, [episode("ep-loud", { publishAt: FUTURE })], { notify: true });
    db.prepare("UPDATE program_episodes SET data_json=json_set(data_json,'$.publishAt',?) WHERE id IN ('ep-quiet','ep-loud')").run(PAST);
    await cron();
    assert.deepEqual(received.map((message) => message.body), ["תוכנית ep-loud"], "only the episode published with the box checked is announced");
  } finally { restore(); }
});

test("deleting every episode does not bring the original catalog back", async () => {
  const { call, admin, db } = await setup();
  const all = db.prepare("SELECT id FROM program_episodes").all().map((row) => row.id);
  assert.ok(all.length >= 80, "a fresh database is seeded once");
  const response = await publish(call, admin, [], { removedIds: all });
  assert.equal(response.status, 200, await response.clone().text());
  await call("/api/program/catalog");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM program_episodes").get().n, 0, "no re-seeding after everything was deleted");

  // מסד מלפני הסימון, שכבר יש בו תוכניות: רק מקבל את הסימון, בלי להחזיר את מה שנמחק
  db.prepare("DELETE FROM program_settings WHERE key='seeded'").run();
  await publish(call, admin, [episode("ep-only")]);
  db.prepare("DELETE FROM program_settings WHERE key='seeded'").run();
  await call("/api/program/catalog");
  assert.deepEqual(db.prepare("SELECT id FROM program_episodes").all().map((row) => row.id), ["ep-only"]);
  assert.ok(db.prepare("SELECT 1 AS one FROM program_settings WHERE key='seeded'").get(), "the marker is set");
});

test("a transcript part sent again replaces its own text instead of being added twice", async () => {
  const { call, env, admin, media, db } = await setup();
  await media.put("program-recordings/retry.mp3", new Uint8Array(2 * 1024 * 1024 * 2 + 100), { httpMetadata: { contentType: "audio/mpeg" } });
  await publish(call, admin, [episode("ep-retry", { r2Key: "program-recordings/retry.mp3" })]);
  let n = 0;
  env.AI = { async run() { n += 1; return { text: `ניסיון ${n}` }; } };
  const part = async (p) => (await call("/api/program/ai/transcribe", { method: "POST", token: admin, body: { episodeId: "ep-retry", part: p } })).json();
  const transcript = async () => (await call("/api/program/ai/transcript/ep-retry", { token: admin })).json();
  await part(0);
  await part(1);
  const again = await part(0);
  assert.equal(again.partsDone, 2, "retrying part 0 after part 1 does not move parts_done backwards");
  await part(1);
  await part(1);
  await part(2);
  assert.deepEqual(await transcript().then((t) => [t.text, t.partsDone, t.partsTotal]), ["ניסיון 3 ניסיון 5 ניסיון 6", 3, 3]);

  // תמלול מלפני שנשמר כל חלק בנפרד: הטקסט המצטבר נשמר, והחלק הבא נוסף אחריו
  db.prepare("UPDATE program_transcripts SET parts_json=NULL, text='ישן', parts_done=2 WHERE episode_id='ep-retry'").run();
  await part(2);
  assert.deepEqual(await transcript().then((t) => [t.text, t.partsDone]), ["ישן ניסיון 7", 3]);
});

test("uploads say what is wrong, with the same limits in the single and the multipart upload", async () => {
  const { call, admin } = await setup();
  const start = (query, body) => call(`/api/program/upload/start?${query}`, { method: "POST", token: admin, body });
  const single = (query, type, size) => call(`/api/program/upload?${query}`, { method: "POST", token: admin, raw: new Uint8Array(4), headers: { "content-type": type, "content-length": String(size) } });
  const error = async (response) => [response.status, (await response.json()).error];
  assert.deepEqual(await error(await start("kind=audio", { contentType: "audio/mpeg", size: 10 })), [400, "חסר מזהה תוכנית."]);
  assert.deepEqual(await error(await single("kind=audio", "audio/mpeg", 10)), [400, "חסר מזהה תוכנית."]);
  assert.deepEqual(await error(await single("episode=ep-1&kind=audio", "text/html", 10)), [400, "סוג הקובץ אינו נתמך."]);
  assert.deepEqual(await error(await single("episode=ep-1&kind=cover", "image/png", 16 * 1024 * 1024)), [400, "התמונה גדולה מ־15MB."]);
  assert.deepEqual(await error(await start("episode=ep-1&kind=cover", { contentType: "image/png", size: 16 * 1024 * 1024 })), [400, "התמונה גדולה מ־15MB."]);
  assert.deepEqual(await error(await single("episode=ep-1&kind=audio", "audio/mpeg", 2 * 1024 ** 3)), [400, "הקובץ גדול מ־1GB."]);
});
