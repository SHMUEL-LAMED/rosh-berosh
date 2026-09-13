import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Google login is exchanged for an opaque 30-day server session", () => {
  const auth = source("worker/auth.ts");
  const worker = source("worker/index.ts");
  assert.match(auth, /60 \* 60 \* 24 \* 30/);
  assert.match(auth, /INSERT INTO auth_sessions/);
  assert.match(auth, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  assert.match(worker, /createSession\(env, user\)/);
  assert.doesNotMatch(worker, /sessionCookie\(credential\)/);
});

test("login offers optional mailing-list consent and subscribes only when checked", () => {
  const auth = source("app/auth-ui.tsx");
  assert.match(auth, /מעוניינים להצטרף לרשימת התפוצה של ראש בראש/);
  assert.match(auth, /type="checkbox"/);
  assert.match(auth, /if \(joinMailingListRef\.current\)/);
  assert.match(auth, /fetch\("\/api\/subscribers", \{ method: "POST" \}\)/);
});

test("site vote checks and progress use the authenticated Google subject", () => {
  const worker = source("worker/index.ts");
  assert.match(worker, /siteVoterKey = user\.sub/);
  assert.match(worker, /site_ballot_progress/);
  assert.match(worker, /DELETE FROM site_ballot_progress WHERE survey_id=\? AND user_sub=\?/);
});

test("a returning voter keeps the site header, account controls and song browser", () => {
  const page = source("app/page.tsx");
  assert.doesNotMatch(page, /if \(voted\) return/);
  assert.match(page, /voted \? <section className="vote-card voted-card"/);
  assert.doesNotMatch(page, /עדיין אפשר להאזין לכל השירים/);
  assert.match(page, /החלפת חשבון/);
  assert.match(page, /<BrowsePanel catalog=\{catalog\}/);
});

test("voting controls and the song browser expose accessible state and dialog behavior", () => {
  const page = source("app/page.tsx");
  assert.match(page, /aria-pressed=\{albums\.includes\(album\.id\)\}/);
  assert.match(page, /aria-pressed=\{artists\.includes\(artist\.id\)\}/);
  assert.match(page, /role="dialog" aria-modal="true"/);
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /event\.key !== "Tab"/);
  assert.match(page, /triggerRef\.current\?\.focus\(\)/);
});

test("audio uploads have a persisted retry queue and idempotency key", () => {
  const queue = source("app/admin/upload-queue.tsx");
  const admin = source("worker/admin.ts");
  assert.match(queue, /indexedDB\.open/);
  assert.match(queue, /xhr\.upload\.onprogress/);
  assert.match(queue, /window\.addEventListener\("online"/);
  assert.match(admin, /INSERT INTO media_uploads/);
  assert.match(admin, /reused: true/);
});

test("admin overview exposes hourly and daily vote channels", () => {
  const admin = source("worker/admin.ts");
  assert.match(admin, /created_at\/3600/);
  assert.match(admin, /created_at\/86400/);
  assert.match(admin, /voteTimeline: \{ hourly: hourlyVotes\.results, daily: dailyVotes\.results \}/);
});

test("admin navigation groups permissions and omits the timeline chart", () => {
  const page = source("app/admin/page.tsx");
  assert.match(page, /setTab\("access"\).*?>הרשאות</s);
  assert.match(page, /tab === "access".*?<ManagersPanel.*?<RecorderAccessPanel/s);
  assert.doesNotMatch(page, /function VoteCharts/);
  assert.doesNotMatch(page, /title="הצבעות לאורך זמן"/);
  const ivrPanel = page.slice(page.indexOf("function IvrPanel"), page.indexOf("function PromptRow"));
  assert.doesNotMatch(ivrPanel, /<RecorderAccessPanel/);
});

test("the upload queue keeps going after the first file, instead of stopping on it", () => {
  const queue = source("app/admin/upload-queue.tsx");
  const finish = queue.slice(queue.indexOf("const finish = async"), queue.indexOf("xhr.onload"));
  const releaseAt = finish.indexOf("processing.current = false");
  const refreshAt = finish.indexOf("await completedRef.current()");
  assert.ok(releaseAt !== -1 && refreshAt !== -1);
  assert.ok(releaseAt < refreshAt, "הנעילה משתחררת רק אחרי רענון הקטלוג, וכל שאר השירים נתקעים בתור");
  assert.match(finish, /setPump\(\(tick\) => tick \+ 1\)/);
  assert.match(queue, /\}, \[processQueue, pump\]\)/);
});

test("the public catalog keeps heavy phone and song media out of the first response", () => {
  const worker = source("worker/index.ts");
  const catalog = worker.slice(worker.indexOf("async function catalog("), worker.indexOf("async function catalogMedia"));
  assert.doesNotMatch(catalog, /readIvrPrompts/);
  assert.doesNotMatch(catalog, /audio_url AS audioUrl/);
  assert.match(worker, /\/api\/catalog\/media/);
  const page = source("app/page.tsx");
  assert.match(page, /loadSongMedia/);
  assert.match(page, /stage === "songs"/);
  assert.match(page, /selectedAlbumId/);
});

test("the public catalog is cached and successful admin changes invalidate it", () => {
  const worker = source("worker/index.ts");
  assert.match(worker, /CATALOG_CACHE_SECONDS = 60/);
  assert.match(worker, /cache\.match\(key\)/);
  assert.match(worker, /cache\.put\(key, cacheable\.clone\(\)\)/);
  assert.match(worker, /request\.method !== "GET" && response\.ok/);
  assert.match(worker, /invalidateCatalogCache\(request, ctx\)/);
});

test("the phone catalog is cached too, and never leaks past the secret check", () => {
  const worker = source("worker/index.ts");
  // הקו הוא הצרכן הכבד: כל שיחה נכנסת מושכת את הקטלוג, ולכן הוא חייב מטמון
  // בדיוק כמו האתר - אבל בלי להיות ניתן לבקשה מבחוץ ובלי להישמר אצל מתווך.
  assert.match(worker, /const IVR_CATALOG_CACHE_KEY = "\/__cache\/ivr-catalog"/);
  assert.match(worker, /cachedIvrCatalog\(request, env, ctx\)/);
  assert.match(worker, /cachedJson\(request, ctx, IVR_CATALOG_CACHE_KEY, \(\) => ivrCatalog\(env\), true\)/);
  assert.match(worker, /headers\.set\("cache-control", "no-store"\)/);
  const route = worker.slice(worker.indexOf('/api/ivr/catalog'), worker.indexOf('/api/ivr/recorders/check'));
  assert.ok(route.indexOf("verifyIvrSecret") < route.indexOf("cachedIvrCatalog"), "הסוד חייב להיבדק לפני שנוגעים במטמון");
});

test("every change that touches the phone payload clears both catalog copies", () => {
  const worker = source("worker/index.ts");
  assert.match(worker, /CATALOG_CACHE_KEYS = \[SITE_CATALOG_CACHE_KEY, IVR_CATALOG_CACHE_KEY\]/);
  assert.match(worker, /for \(const pathname of CATALOG_CACHE_KEYS\)/);
  const promptUpload = worker.slice(worker.indexOf('/api/ivr/prompt'), worker.indexOf('/api/ballots/check'));
  assert.match(promptUpload, /invalidateCatalogCache\(request, ctx\)/, "העלאת קריינות משנה את קטלוג הקו וחייבת למחוק אותו");
});

test("the phone catalog reads the active survey inside its batch, not before it", () => {
  const catalogModule = source("worker/ivr-catalog.js");
  // הפנייה הראשונה ל-surveys רצה לבדה, ורק כשחזרה נשלחה שאר הקבוצה: שתי
  // הליכות אל D1 בכל שיחה נכנסת במקום אחת.
  assert.doesNotMatch(catalogModule, /await db\.prepare\("SELECT id FROM surveys/);
  assert.match(catalogModule, /const ACTIVE_SURVEY_SQL = "COALESCE\(\(SELECT id FROM surveys/);
  assert.match(catalogModule, /SELECT \$\{ACTIVE_SURVEY_SQL\} AS id/);
  const [, batch] = catalogModule.split("db.batch([");
  assert.doesNotMatch(batch.slice(0, batch.indexOf("]),")), /\.bind\(surveyId\)/, "אין עוד מזהה סקר שנקרא מראש להזרקה");
});

test("an album upload also stores the cover that came with the files", () => {
  const page = source("app/admin/page.tsx");
  assert.match(page, /if \(split\.cover\) \{/);
  assert.match(page, /coverForm\.set\("kind", "cover"\)/);
});
