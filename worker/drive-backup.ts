/**
 * גיבוי חד-פעמי של כל האלבומים לגוגל דרייב — למנהלים בלבד.
 *
 * הדף /admin/drive-backup מבקש מגוגל, בדפדפן של המנהל, הרשאת drive.file
 * (גישה רק לקבצים שהדף עצמו יוצר). השרת מעתיק כל קובץ ישירות מ-R2 לדרייב,
 * כך שהקבצים לא עוברים דרך המחשב של המנהל. ההרשאה נשלחת לשרת בכל בקשה ואינה
 * נשמרת בשום מקום.
 *
 * זו אפשרות זמנית: אחרי שההעתקה מסתיימת מוחקים את הקובץ הזה ואת ההפניות
 * אליו ב-worker/index.ts.
 */
import { GOOGLE_CLIENT_ID, readSession } from "./auth";

type DriveEnv = { DB?: D1Database; MEDIA: R2Bucket; ADMIN_EMAILS?: string };
type Body = { name?: string; parentId?: string; key?: string };

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

class DriveError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Google Drive ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function ensureOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const detail = await response.text().catch(() => "");
  throw new DriveError(response.status, detail.slice(0, 800));
}

type DriveInit = { method?: string; headers?: Record<string, string>; body?: string };

function driveFetch(token: string, url: string, init: DriveInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

/** שם שמתאים גם לדרייב וגם למחשב (בלי תווים שאסורים בשמות קבצים ב-Windows). */
function cleanName(value: unknown): string {
  const printable = Array.from(String(value ?? "")).filter((char) => char.charCodeAt(0) >= 32).join("");
  return printable.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 200);
}

const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function findChild(token: string, parentId: string, name: string, folder: boolean) {
  const q = `name='${quote(name)}' and '${quote(parentId)}' in parents and trashed=false${folder ? ` and mimeType='${FOLDER_MIME}'` : ""}`;
  const response = await ensureOk(await driveFetch(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,size)&pageSize=1&spaces=drive`));
  const data = await response.json<{ files?: { id: string; size?: string }[] }>();
  return data.files?.[0] ?? null;
}

export async function driveBackupPage(request: Request, env: DriveEnv): Promise<Response> {
  const user = await readSession(request, env);
  if (!user?.isAdmin) return Response.redirect(new URL("/admin", request.url).toString(), 302);
  return new Response(PAGE_HTML, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

export async function driveBackupApi(request: Request, env: DriveEnv): Promise<Response> {
  const user = await readSession(request, env);
  if (!user?.isAdmin) return json({ error: "אין הרשאת מנהל." }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = (request.headers.get("x-drive-token") || "").trim();
  if (!token) return json({ error: "חסרה הרשאה מגוגל דרייב." }, 400);
  const { pathname } = new URL(request.url);
  const body = await request.json<Body>().catch((): Body => ({}));

  try {
    if (pathname === "/api/admin/drive-backup/quota") {
      const response = await ensureOk(await driveFetch(token, `${DRIVE_API}/about?fields=user(emailAddress),storageQuota`));
      const about = await response.json<{ user?: { emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } }>();
      const limit = about.storageQuota?.limit ? Number(about.storageQuota.limit) : null;
      const usage = Number(about.storageQuota?.usage || 0);
      return json({ email: about.user?.emailAddress || "", free: limit === null ? null : Math.max(0, limit - usage) });
    }

    if (pathname === "/api/admin/drive-backup/folder") {
      const name = cleanName(body.name);
      const parentId = String(body.parentId || "root");
      if (!name) return json({ error: "חסר שם תיקייה." }, 400);
      const existing = await findChild(token, parentId, name, true);
      if (existing) return json({ id: existing.id, created: false });
      const response = await ensureOk(await driveFetch(token, `${DRIVE_API}/files?fields=id`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      }));
      const created = await response.json<{ id: string }>();
      return json({ id: created.id, created: true });
    }

    if (pathname === "/api/admin/drive-backup/file") {
      const key = String(body.key || "");
      const name = cleanName(body.name);
      const parentId = String(body.parentId || "");
      if (!key.startsWith("albums/") || key.includes("..") || !name || !parentId) return json({ error: "בקשה לא תקינה." }, 400);
      const existing = await findChild(token, parentId, name, false);
      if (existing) return json({ id: existing.id, skipped: true });
      const object = await env.MEDIA.get(key);
      if (!object) return json({ error: "הקובץ לא נמצא באתר.", key }, 404);
      const contentType = object.httpMetadata?.contentType || "application/octet-stream";
      // העלאה בהמשכים (resumable): קודם פותחים העלאה עם השם והתיקייה, ואז שולחים
      // את הקובץ עצמו ישר מ-R2 בזרימה, בלי לטעון אותו כולו לזיכרון.
      const session = await ensureOk(await driveFetch(token, `${UPLOAD_API}?uploadType=resumable&fields=id`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": contentType,
          "x-upload-content-length": String(object.size),
        },
        body: JSON.stringify({ name, parents: [parentId] }),
      }));
      const location = session.headers.get("location");
      if (!location) throw new DriveError(502, "Google Drive did not return an upload URL");
      const upload = await ensureOk(await fetch(location, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: object.body.pipeThrough(new FixedLengthStream(object.size)),
      }));
      const done = await upload.json<{ id?: string }>().catch((): { id?: string } => ({}));
      return json({ id: done.id || "", size: object.size, skipped: false });
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message, detail: error.detail }, error.status === 401 ? 401 : 502);
    console.error("drive backup error", pathname, error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

const PAGE_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>גיבוי האלבומים לדרייב</title>
<style>
  :root { color-scheme: light dark; --bg: #faf7f0; --card: #fff; --ink: #1f2328; --muted: #6b7280; --accent: #1a73e8; --ok: #188038; --bad: #c5221f; --line: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16181c; --card: #1f2227; --ink: #e8eaed; --muted: #9aa0a6; --line: #33373d; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 system-ui, "Segoe UI", Arial, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; }
  p { margin: 6px 0; color: var(--muted); }
  button { font: inherit; font-weight: 600; background: var(--accent); color: #fff; border: 0; border-radius: 10px; padding: 12px 20px; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  .bar { height: 12px; background: var(--line); border-radius: 99px; overflow: hidden; margin: 14px 0 8px; }
  .bar > div { height: 100%; width: 0; background: var(--ok); transition: width .3s; }
  #status { font-weight: 600; }
  #stats { color: var(--muted); font-size: .95rem; }
  #log { list-style: none; padding: 0; margin: 0; max-height: 360px; overflow: auto; font-size: .92rem; }
  #log li { padding: 4px 0; border-bottom: 1px solid var(--line); }
  #log li.bad { color: var(--bad); }
  #log li.ok { color: var(--ok); }
  a { color: var(--accent); }
</style>
<script src="https://accounts.google.com/gsi/client" async defer></script>
</head>
<body>
<main>
  <div class="card">
    <h1>גיבוי כל האלבומים לגוגל דרייב</h1>
    <p>הקבצים מועתקים ישירות מהשרת של האתר לדרייב, לתיקייה <b>ראש בראש - כל האלבומים</b>, עם תיקייה לכל אלבום.</p>
    <p>יש להשאיר את הדף פתוח עד הסוף. אם ההעתקה נעצרת, לוחצים שוב על הכפתור והיא ממשיכה מאיפה שנעצרה.</p>
    <p style="margin-top:14px"><button id="start" type="button">התחברות לדרייב והתחלת ההעתקה</button></p>
  </div>
  <div class="card">
    <div id="status">עוד לא התחיל.</div>
    <div class="bar"><div id="bar"></div></div>
    <div id="stats"></div>
  </div>
  <div class="card"><ul id="log"></ul></div>
</main>
<script>
(function () {
  var CLIENT_ID = ${JSON.stringify(GOOGLE_CLIENT_ID)};
  var SCOPE = "https://www.googleapis.com/auth/drive.file";
  var ROOT_NAME = "ראש בראש - כל האלבומים";
  var CONCURRENCY = 4;
  var token = "";
  var running = false;
  var $ = function (id) { return document.getElementById(id); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function log(message, cls) {
    var li = document.createElement("li");
    li.textContent = message;
    if (cls) li.className = cls;
    $("log").insertBefore(li, $("log").firstChild);
  }
  function status(message) { $("status").textContent = message; }

  function getToken() {
    return new Promise(function (resolve, reject) {
      if (!window.google || !google.accounts || !google.accounts.oauth2) { reject(new Error("הרכיב של גוגל עוד לא נטען. נסו שוב בעוד רגע.")); return; }
      var client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: function (r) { if (r && r.access_token) resolve(r.access_token); else reject(new Error((r && (r.error_description || r.error)) || "לא התקבלה הרשאה מגוגל.")); },
        error_callback: function (e) { reject(new Error("חלון ההרשאה של גוגל נסגר או נחסם (" + ((e && e.type) || "error") + ").")); }
      });
      client.requestAccessToken();
    });
  }

  function api(path, body) {
    var attempt = 0;
    function once() {
      attempt++;
      return fetch("/api/admin/drive-backup/" + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-drive-token": token },
        body: JSON.stringify(body || {})
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.ok) return data;
          var message = (data.error || ("HTTP " + res.status)) + (data.detail ? " — " + data.detail : "");
          if (res.status === 401) { var authError = new Error("ההרשאה מגוגל פגה. לחצו שוב על הכפתור כדי להמשיך."); authError.auth = true; throw authError; }
          if (res.status === 400 || res.status === 403 || res.status === 404 || attempt >= 3) throw new Error(message);
          return sleep(2000 * attempt).then(once);
        });
      }, function (error) {
        if (attempt >= 3) throw error;
        return sleep(2000 * attempt).then(once);
      });
    }
    return once();
  }

  function keyOf(url) { return String(url || "").replace(/^\\/media\\//, "").split("/").map(decodeURIComponent).join("/"); }
  function extOf(url, fallback) { var m = decodeURIComponent(String(url || "").split("?")[0]).match(/\\.([a-z0-9]{2,5})$/i); return m ? m[1].toLowerCase() : fallback; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function gb(bytes) { return (bytes / 1e9).toFixed(1) + "GB"; }

  function pool(items, size, worker) {
    var index = 0;
    function next() {
      if (index >= items.length) return Promise.resolve();
      var item = items[index++];
      return worker(item).then(next);
    }
    var runners = [];
    for (var i = 0; i < Math.min(size, items.length); i++) runners.push(next());
    return Promise.all(runners);
  }

  async function run() {
    if (running) return;
    running = true;
    $("start").disabled = true;
    var copied = 0, skipped = 0, failed = [], bytes = 0, doneCount = 0, total = 0;
    function progress() {
      $("bar").style.width = (total ? Math.round(doneCount * 100 / total) : 0) + "%";
      $("stats").textContent = doneCount + " מתוך " + total + " קבצים · הועתקו עכשיו " + copied + " (" + gb(bytes) + ")" + (skipped ? " · כבר היו בדרייב " + skipped : "") + (failed.length ? " · נכשלו " + failed.length : "");
    }
    try {
      if (!token) { status("מתחבר לגוגל דרייב…"); token = await getToken(); }
      var quota = await api("quota");
      log("מחובר לדרייב של " + (quota.email || "החשבון שנבחר") + (quota.free !== null ? " · פנוי " + gb(quota.free) : ""), "ok");
      status("טוען את רשימת האלבומים…");
      var responses = await Promise.all([fetch("/api/catalog"), fetch("/api/catalog/media")]);
      var catalog = await responses[0].json();
      var media = await responses[1].json();
      var mediaById = {};
      media.songs.forEach(function (s) { mediaById[s.id] = s; });
      var albums = catalog.albums.map(function (album) {
        var tasks = [];
        if (album.coverUrl) tasks.push({ key: keyOf(album.coverUrl), name: "cover." + extOf(album.coverUrl, "jpg") });
        catalog.songs.filter(function (s) { return s.albumId === album.id; }).forEach(function (s, i) {
          var m = mediaById[s.id];
          if (m && m.audioUrl) tasks.push({ key: keyOf(m.audioUrl), name: pad(i + 1) + " - " + s.title + "." + extOf(m.audioUrl, "mp3") });
        });
        return { album: album, tasks: tasks };
      });
      albums.forEach(function (a) { total += a.tasks.length; });
      progress();
      var root = await api("folder", { name: ROOT_NAME, parentId: "root" });
      for (var i = 0; i < albums.length; i++) {
        var entry = albums[i];
        var title = entry.album.artistName + " - " + entry.album.title;
        status("מעתיק (" + (i + 1) + "/" + albums.length + "): " + title);
        var folder = await api("folder", { name: title, parentId: root.id });
        var albumFailed = 0;
        await pool(entry.tasks, CONCURRENCY, function (task) {
          return api("file", { key: task.key, name: task.name, parentId: folder.id }).then(function (r) {
            if (r.skipped) skipped++; else { copied++; bytes += Number(r.size || 0); }
          }, function (error) {
            if (error.auth) throw error;
            albumFailed++;
            failed.push({ title: title, task: task, folderId: folder.id });
            log("נכשל: " + title + " / " + task.name + " — " + error.message, "bad");
          }).then(function () { doneCount++; progress(); });
        });
        log((albumFailed ? "⚠ " : "✓ ") + title + (albumFailed ? " (" + albumFailed + " נכשלו)" : ""), albumFailed ? "bad" : "ok");
      }
      if (failed.length) {
        status("מנסה שוב " + failed.length + " קבצים שנכשלו…");
        var retry = failed; failed = [];
        await pool(retry, 2, function (f) {
          return api("file", { key: f.task.key, name: f.task.name, parentId: f.folderId }).then(function (r) {
            if (r.skipped) skipped++; else { copied++; bytes += Number(r.size || 0); }
            log("✓ בניסיון חוזר: " + f.title + " / " + f.task.name, "ok");
          }, function (error) {
            if (error.auth) throw error;
            failed.push(f);
            log("נכשל שוב: " + f.title + " / " + f.task.name + " — " + error.message, "bad");
          }).then(progress);
        });
      }
      status(failed.length ? "הסתיים, אבל " + failed.length + " קבצים נכשלו. אפשר ללחוץ שוב כדי לנסות אותם." : "הסתיים! כל האלבומים נמצאים בדרייב בתיקייה \\"" + ROOT_NAME + "\\".");
    } catch (error) {
      if (error && error.auth) token = "";
      status("נעצר: " + (error && error.message ? error.message : error));
      log("נעצר: " + (error && error.message ? error.message : error), "bad");
    } finally {
      running = false;
      $("start").disabled = false;
      $("start").textContent = "המשך / התחלה מחדש";
    }
  }

  $("start").addEventListener("click", run);
})();
</script>
</body>
</html>`;
