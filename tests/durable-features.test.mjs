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

test("login offers mailing-list consent only after successful sign-in", () => {
  const auth = source("app/auth-ui.tsx");
  const subscribe = source("app/subscribe.tsx");
  const page = source("app/page.tsx");
  assert.match(auth, /sessionStorage\.setItem\("rosh-berosh-show-subscribe", "1"\)/);
  assert.doesNotMatch(auth, /type="checkbox"/);
  assert.match(subscribe, /function SubscribeAfterLogin/);
  assert.match(subscribe, /fetch\("\/api\/subscribers", \{ method: "POST"/);
  assert.match(page, /<SubscribeAfterLogin \/>/);
});

test("site vote checks and progress use the authenticated Google subject", () => {
  const worker = source("worker/index.ts");
  assert.match(worker, /siteVoterKey = user\.sub/);
  assert.match(worker, /site_ballot_progress/);
  assert.match(worker, /DELETE FROM site_ballot_progress WHERE survey_id=\? AND user_sub=\?/);
});

test("site ballots keep the Google email and blocked computers are rejected server-side", () => {
  const worker = source("worker/index.ts");
  const admin = source("worker/admin.ts");
  assert.match(worker, /voterEmail: user\.email/);
  assert.match(worker, /INSERT INTO ballots \(id,survey_id,voter_key,voter_email,channel,fingerprint,started_at,albums_done_at,songs_done_at,artists_done_at,sessions\)/);
  assert.match(worker, /SELECT 1 AS blocked FROM blocked_fingerprints/);
  assert.match(admin, /\/api\/admin\/blocked-fingerprints/);
  assert.match(admin, /COALESCE\(b\.voter_email,\(SELECT s\.email FROM auth_sessions/);
});

test("successful voters receive a downloadable and shareable branded receipt", () => {
  const page = source("app/page.tsx");
  const worker = source("worker/index.ts");
  assert.match(page, /function VoteReceipt/);
  assert.match(page, /הורדת הכרטיס/);
  assert.match(page, /שיתוף ההצבעה שלי/);
  assert.match(page, /new File\(\[blob\], "ההצבעה-שלי-ראש-בראש\.png"/);
  assert.match(page, /navigator\.share/);
  assert.match(page, /savedReceipt && <VoteReceipt/);
  assert.match(page, /album\.coverUrl/);
  assert.match(page, /artist\.imageUrl/);
  assert.match(page, /loadReceiptImage/);
  assert.match(page, /drawReceiptImage/);
  assert.match(page, /preparedFile/);
  assert.match(page, /document\.body\.appendChild\(link\)/);
  assert.match(page, /כרטיס ההצבעה הורד בהצלחה/);
  assert.match(page, /הדפדפן לא תומך בשיתוף קובץ ישיר/);
  assert.match(worker, /receipt: \{/);
  assert.match(worker, /a\.cover_url AS coverUrl/);
  assert.match(worker, /a\.image_url AS imageUrl/);
  assert.match(worker, /if \(!existing && blocked\)/, "a blocked computer must still be able to share an existing authenticated ballot");
});

test("voters are invited to share the parade: after voting, on return, mid-vote and from the header", () => {
  const share = source("app/share-parade.tsx");
  const page = source("app/page.tsx");
  // השיתוף הוא מייל מעוצב, שיתוף מהמכשיר והעתקת הקישור — בלי כפתורי וואטסאפ וטלגרם.
  assert.doesNotMatch(share, /wa\.me|t\.me\/share|וואטסאפ|טלגרם/);
  // מייל מעוצב אי אפשר למלא בקישור, ולכן ההזמנה מועתקת כ־HTML בתוך הלחיצה עצמה ומודבקת במייל.
  assert.match(share, /event\.clipboardData\.setData\("text\/html", html\)/);
  assert.match(share, /copied = document\.execCommand\("copy"\)/);
  assert.match(share, /new ClipboardItem\(\{ "text\/html"/, "the async clipboard is the fallback");
  assert.match(share, /const body = mail === "failed" \? text : undefined;/, "without a rich copy the email opens with the text invitation");
  assert.match(share, /srcDoc=\{previewDoc\}/, "the voter sees the designed invitation before sending it");
  // שיתוף מהמכשיר שולח תמונת הזמנה מעוצבת, מוכנה מראש כי חלון השיתוף חייב להיפתח מיד בלחיצה.
  assert.match(share, /files: \[imageFile\.current\]/);
  assert.match(share, /navigator\.canShare\?\.\(withImage\)/);
  assert.match(share, /typeof navigator\.share === "function"/, "the device share sheet is offered only where it exists");
  assert.match(share, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(share, /window\.location\.origin/, "the shared link follows the domain the site was opened from");
  // מסך התודה ומסך "כבר הצבעתם" מציגים את הכרטיס; החלון קופץ למי שכבר הצביע,
  // באמצע ההצבעה, ומכפתור קבוע בכותרת.
  assert.equal((page.match(/<ShareParadeCard \/>/g) || []).length, 2);
  assert.match(page, /oncePer\("session", SHARE_VOTED_KEY\)\) setSharePrompt\("voted"\)/);
  assert.match(page, /target > stageIndex && target === middleStage && \(preview \|\| oncePer\("local", SHARE_MID_KEY\)\)\) setSharePrompt\("mid"\)/);
  assert.match(page, /className="share-nav" onClick=\{\(\) => setSharePrompt\("manual"\)\}><ShareIcon \/>שיתוף המצעד/);
  // אחרי התחברות חדשה חלון רשימת התפוצה כבר על המסך — שני חלונות אינם קופצים יחד.
  assert.match(page, /if \(preview \|\| voted !== true \|\| freshLogin\) return;/);
  assert.match(page, /\{sharePrompt && <ShareParadeDialog reason=\{sharePrompt\} onClose=\{closeShare\} \/>\}/);
});

test("admin preview reaches the final screen without writing a ballot or progress", () => {
  const page = source("app/page.tsx");
  const admin = source("app/admin/page.tsx");
  assert.match(page, /requestedPreview === "site" \|\| requestedPreview === "ivr"/);
  assert.match(page, /if \(preview\) \{ setDone\(true\); stop\(\); return; \}/);
  assert.match(page, /preview \|\| !catalog \|\| voted !== false/);
  assert.match(page, /שום הצבעה או התקדמות לא נשמרו/);
  assert.match(admin, /\?preview=site/);
  assert.match(admin, /<PhonePreview/);
  const phone = source("app/admin/phone-preview.tsx");
  assert.match(phone, /speechSynthesis\.speak/);
  assert.match(phone, /className="phone-keypad"/);
  assert.match(phone, /התחלת שיחת בדיקה/);
  assert.match(admin, /הקישו <b>75<\/b>/);
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
  assert.match(worker, /CATALOG_CACHE_KEYS = \[SITE_CATALOG_CACHE_KEY, SITE_MEDIA_CACHE_KEY, IVR_CATALOG_CACHE_KEY\]/);
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

test("ballots carry voting timing from both channels and the schema stores it", () => {
  const worker = source("worker/index.ts");
  const schema = source("worker/schema-statements.js");
  const site = source("app/page.tsx");
  const phone = source("ivr-service/src/server.js");
  for (const column of ["started_at", "albums_done_at", "songs_done_at", "artists_done_at", "sessions"]) {
    assert.match(schema, new RegExp(`column: "${column}"`), `runtime schema adds ballots.${column}`);
    assert.match(schema, new RegExp(`${column} INTEGER`), `fresh ballots table has ${column}`);
  }
  assert.match(worker, /const timing = sanitizeTiming\(body\.timing\)/);
  assert.match(worker, /seconds > now \+ 60 \|\| seconds < now - 366 \* 86400/);
  assert.match(site, /channel: "site", fingerprint: fp, timing: timing && \{ \.\.\.timing, clientNow: nowSeconds\(\) \}/, "the site reports its own clock so the server can correct for skew");
  assert.match(site, /setTiming\(\(current\) => current \?\? restoreTiming\(null\)\)/, "a failed progress load must not silently disable the measurement");
  assert.match(site, /sessionStorage\.getItem\(VISIT_KEY\)/, "a refresh of the same tab is not a new visit");
  assert.match(site, /markStageDone\("albumsDoneAt"\)/);
  assert.match(site, /markStageDone\("songsDoneAt"\)/);
  assert.match(site, /markStageDone\("artistsDoneAt"\)/);
  assert.match(phone, /channel: "phone", timing: timing && \{ \.\.\.timing, clientNow: /, "the phone line reports its clock too");
  assert.match(phone, /const finishedOnEntry = \{/, "a stage already finished before this call is not stamped with the current time");
  assert.match(phone, /const saveInBackground = /, "the entry write must not hold the caller before the first menu");
  assert.match(phone, /let timing = preview \? null : restoreTiming\(saved\)/);
});

test("the admin has a separate advanced-data tab that leaves results and voters untouched", () => {
  const page = source("app/admin/page.tsx");
  const admin = source("worker/admin.ts");
  assert.match(page, /setTab\("analytics"\).*?>נתונים מתקדמים</s);
  assert.match(page, /tab === "analytics" && <AnalyticsPanel/);
  assert.match(page, /tab === "results" && data && <Results data=\{data\.results\}/);
  assert.match(page, /tab === "voters" && <VotersPanel/);
  assert.match(admin, /url\.pathname === "\/api\/admin\/analytics"/);
  const analytics = source("worker/analytics.ts");
  for (const key of ["albumBreakdown", "zeroVotes", "artistAlbums", "albumCompanions", "artistPairs", "combos", "timing", "daily", "blocked", "audit", "content"]) assert.match(analytics, new RegExp(`\\b${key}[,:]`), `analytics returns ${key}`);
});

test("a ballot submission builds the runtime schema on both channels", () => {
  const worker = source("worker/index.ts");
  const route = worker.slice(worker.indexOf('url.pathname === "/api/ballots" && request.method === "POST"'));
  const guard = route.slice(0, route.indexOf("let original"));
  assert.match(guard, /await ensureRuntimeSchema\(env\);/, "a phone ballot arriving first after a deploy must not hit a missing column");
  assert.doesNotMatch(guard, /if \(!fromIvr\) \{\s*await ensureRuntimeSchema/, "the schema build is no longer behind the site-only branch");
});

test("each stage stamp is validated against the start, not against the stage before it", () => {
  const worker = source("worker/index.ts");
  // בקו אפשר לסיים שלבים בכל סדר, ושרשור הבדיקות מחק חותמות תקינות.
  assert.match(worker, /const songsDoneAt = startedAt === null \? null : stamp\(timing\?\.songsDoneAt, startedAt\)/);
  assert.match(worker, /const artistsDoneAt = startedAt === null \? null : stamp\(timing\?\.artistsDoneAt, startedAt\)/);
  assert.match(worker, /const skew = Math\.abs\(rawSkew\) <= 86400 \? rawSkew : 0/, "a client clock is corrected, not trusted");
});

test("a song is counted once per ballot and cannot be filed under a foreign album", () => {
  const worker = source("worker/index.ts");
  const analytics = source("worker/analytics.ts");
  const admin = source("worker/admin.ts");
  assert.match(worker, /const misfiledSong = /);
  assert.match(analytics, /COUNT\(DISTINCT v\.ballot_id\) AS votes/);
  assert.match(analytics, /LEFT JOIN song_votes v ON v\.song_id=s\.id AND v\.album_id=s\.album_id/);
  assert.match(admin, /COUNT\(DISTINCT v\.ballot_id\) AS votes/);
  assert.doesNotMatch(admin, /COUNT\(v\.song_id\) AS votes/, "the results tab must agree with the advanced-data tab");
});

test("the advanced-data tab is browsed through an internal menu, not one long page", () => {
  const page = source("app/admin/analytics-panel.tsx");
  assert.match(page, /const SECTIONS: Array<\{ key: Section; label: string; help: string \}>/);
  assert.match(page, /<nav className="analytics-nav"/);
  assert.match(page, /section === "pace" &&/, "only the chosen section is rendered");
  assert.doesNotMatch(page, /function Block\(/, "the collapsible stack is gone");
  const css = source("app/admin/analytics-panel.css");
  assert.match(css, /\.analytics-nav\{[^}]*position:sticky/, "the menu stays reachable while a section scrolls");
});

test("percent-only mode cannot leak an exact count, because every count goes through one formatter", () => {
  const page = source("app/admin/analytics-panel.tsx");
  const body = page.slice(page.indexOf("export function AnalyticsPanel"));
  // מותר להשתמש ב-toLocaleString רק בתוך הפורמטר עצמו ובתאריכים.
  assert.doesNotMatch(body, /\.toLocaleString\("he-IL"\)/, "counts must not be formatted directly");
  assert.match(page, /const count = \(votes: number, whole = total\) => \(percentOnly \? /);
  for (const component of ["TimingSection", "OpsSection", "CrossSections", "PeopleSection", "ContentSection"]) {
    assert.match(page, new RegExp(`function ${component}\\(\\{ data, format \\}`), `${component} receives the formatter`);
  }
});

test("the charts are hand-written SVG with a validated palette and a text alternative", () => {
  const charts = source("app/admin/analytics-charts.tsx");
  const pkg = JSON.parse(source("package.json"));
  for (const dependency of Object.keys(pkg.dependencies)) {
    assert.ok(!/chart|d3|recharts|plotly|victory/i.test(dependency), `no chart library may be added: ${dependency}`);
  }
  assert.match(charts, /CHANNEL_COLOR = \{ site: "#1699a8", phone: "#b3831f" \}/);
  assert.match(charts, /HEAT_STEPS = \["#cfa94f", "#b38a2c", "#8f6e1e", "#6d5314", "#4b380b"\]/);
  for (const chart of ["CumulativeChart", "DailyColumns", "ActivityHeatmap", "RaceChart", "ChannelSplit", "RankBars"]) {
    assert.match(charts, new RegExp(`export function ${chart}`), `${chart} exists`);
  }
  // כל גרף נושא חלופה טקסטואלית, ואף אחד אינו נשען על צבע בלבד.
  const svgCharts = charts.split("export function ").filter((block) => /<svg /.test(block));
  for (const block of svgCharts) assert.match(block, /role="img" aria-label=/, `a chart without a label: ${block.slice(0, 40)}`);
});

test("the features chosen for the announcement and the audience are built from the payload, not invented in the browser", () => {
  const analytics = source("worker/analytics.ts");
  const panel = source("app/admin/analytics-panel.tsx");
  const types = source("app/admin/analytics-types.ts");
  for (const key of ["composite", "tasteGroups", "anomalies", "abandonedPicks"]) {
    assert.match(types, new RegExp(`${key}:`), `${key} is in the shared contract`);
    assert.match(analytics, new RegExp(`\\b${key},`), `${key} is returned by the worker`);
  }
  assert.match(analytics, /function buildTasteGroups/);
  assert.match(analytics, /function findAnomalies/);
  // קבוצה אינה מתארת את עצמה: לא הזרע ולא האלבום שנתן לה את השם.
  assert.match(analytics, /id !== seed && id !== group\[0\]/);
  assert.match(panel, /function CompositeBallotCard/);
  assert.match(panel, /function CatalogHeat/);
  assert.match(panel, /function TasteSection/);
  assert.match(panel, /function GoldenHour/);
  assert.match(panel, /function ChangeStrip/);
});

test("the share image is drawn, not screenshotted, and never leaks a count in percent-only mode", () => {
  const share = source("app/admin/analytics-share.ts");
  const panel = source("app/admin/analytics-panel.tsx");
  assert.match(share, /ctx\.direction = "rtl"/, "canvas does not inherit the document direction");
  assert.match(share, /function fit\(/, "titles are shortened by measured width, never mid-character");
  assert.match(panel, /value: format\.count\(item\.votes\)/, "the image takes its numbers from the same formatter as the screen");
  assert.doesNotMatch(panel, /shareTopTen\(data, percentOnly/, "the raw flag is not threaded past the formatter");
});

test("what changed since the last visit reads the previous snapshot before overwriting it", () => {
  const panel = source("app/admin/analytics-panel.tsx");
  const strip = panel.slice(panel.indexOf("function ChangeStrip"), panel.indexOf("/** הפתק שמייצג"));
  const readAt = strip.indexOf("readSnapshot(surveyKey)");
  const writeAt = strip.indexOf("writeSnapshot(surveyKey");
  assert.ok(readAt > -1 && writeAt > -1 && readAt < writeAt, "reading the baseline must happen before it is replaced");
  assert.match(strip, /baselineWritten\.current === surveyKey/, "the baseline is fixed once per visit, so a refresh keeps comparing to the same point");
  assert.match(panel, /catch \{ \/\* אחסון חסום/, "blocked storage hides the strip instead of throwing");
});

test("the panel only reports what a voter can actually reach", () => {
  const analytics = source("worker/analytics.ts");
  const catalog = source("worker/ivr-catalog.js");
  // אותו תנאי שקטלוג הקו משתמש בו: הקלטה שלא הסתנכרנה אינה מושמעת.
  assert.match(catalog, /WHERE yemot_path IS NOT NULL AND yemot_path != ''/);
  assert.match(analytics, /SELECT key FROM ivr_prompts WHERE yemot_path IS NOT NULL AND yemot_path != ''/);
  // פריט מוסתר אינו מוצג ואינו מושמע, ולכן אינו נספר כתוכן חסר.
  assert.match(analytics, /const liveSongs = songRows\.filter\(\(row\) => num\(row\.active\) && num\(row\.albumActive\)\)/);
  for (const group of ["songsWithoutAudio", "songsWithoutPreview", "albumsWithoutCover", "artistsWithoutImage"]) {
    assert.match(analytics, new RegExp(`${group}: live`), `${group} is built from the live catalogue`);
  }
  assert.match(analytics, /filter\(\(\[, votes\]\) => votes > 1\)/, "a combination with no twin is not a recurring combination");
});

test("a phone stage is stamped when the caller leaves it, not when its minimum is reached", () => {
  const phone = source("ivr-service/src/server.js");
  assert.match(phone, /const finishStage = \(key, done\) =>/);
  // השמירה עצמה כבר אינה חותמת: chooseMany שומר אחרי כל הקשה.
  const persist = phone.slice(phone.indexOf("const persistProgress = () =>"), phone.indexOf("const keepSongsForSelectedAlbums"));
  assert.doesNotMatch(persist, /stampStages\(\)/, "saving progress must not stamp a stage the caller is still inside");
  // שישה מקומות: שלושה שלבים בשני מסלולי התפריט.
  assert.ok((phone.match(/finishStage\("/g) || []).length >= 8, "every stage exit stamps, on both menu paths");
});

test("all song media loads in one cached request alongside the catalog", () => {
  const worker = source("worker/index.ts");
  assert.match(worker, /const SITE_MEDIA_CACHE_KEY = "\/__cache\/catalog-media"/);
  assert.match(worker, /cachedJson\(request, ctx, SITE_MEDIA_CACHE_KEY, \(\) => catalogMedia\(request, env\)\)/);
  const page = source("app/page.tsx");
  const load = page.slice(page.indexOf("const loadCatalog = useCallback"), page.indexOf("const loadSongMedia = useCallback"));
  // הבקשה לקבצים יוצאת לפני שמחכים לקטלוג, ולא אחריו.
  assert.ok(load.indexOf("fetchSongMedia(null)") < load.indexOf('fetch("/api/catalog"'));
  assert.match(page, /await mediaSettled\.current/);
});

test("songs and the player use the album's image", () => {
  const worker = source("worker/index.ts");
  assert.match(worker, /COALESCE\(NULLIF\(a\.cover_url,''\), s\.cover_url\) AS coverUrl/);
  const page = source("app/page.tsx");
  assert.match(page, /play\(withAlbumCover\(song, album\)\)/);
  assert.match(page, /play\(withAlbumCover\(song, selectedAlbum\)\)/);
  const admin = source("worker/admin.ts");
  assert.match(admin, /UPDATE songs SET cover_url=\? WHERE album_id=\?"\)\.bind\(coverUrl, albumId\)/);
  assert.match(admin, /let coverUrl: string \| null = album\.coverUrl \|\| null;/);
});

test("public media is kept in the edge cache and ranges are served from it", () => {
  const worker = source("worker/index.ts");
  const serve = worker.slice(worker.indexOf("async function serveMedia("), worker.indexOf("async function route("));
  assert.ok(serve.indexOf("privateObject) return") < serve.indexOf("cache.match"), "קבצים פרטיים נחסמים לפני המטמון");
  assert.match(serve, /headers: \{ range: rangeHeader \}/);
  assert.match(serve, /new FixedLengthStream\(object\.size\)/);
  assert.match(serve, /MEDIA_EDGE_CACHE_MAX_BYTES/);
  // ב-workers.dev המטמון אינו פועל, ואסור שיגרור שם קריאה כפולה מ-R2.
  assert.match(serve, /hostname\.endsWith\("\.workers\.dev"\) \? undefined/);
});
