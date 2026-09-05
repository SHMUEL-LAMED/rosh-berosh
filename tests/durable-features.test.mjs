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
