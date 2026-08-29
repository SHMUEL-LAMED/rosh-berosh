const express = require("express");
const { createHash } = require("crypto");
const { YemotRouter } = require("yemot-router2");
const { normalizePhone, phone } = require("./phone");
const { continuousMenuInput, menuCode, menuCodeWidth, menuReadOptions } = require("./menu-input");
const { sanitizeProgress, progressChanged } = require("./progress");
const RECORDABLE_SYSTEM_PROMPTS = require("./ivr-system-prompts.json");
const { ADMIN_SECTIONS, adminReadOptions, resolveAdminCode } = require("./admin-menu");

const SITE_API_BASE_URL = process.env.SITE_API_BASE_URL;
const IVR_SECRET = process.env.IVR_SECRET;
const RECORDINGS_YEMOT_TOKEN = String(process.env.RECORDINGS_YEMOT_TOKEN || "").trim();
const RECORDINGS_YEMOT_API_BASE = String(process.env.RECORDINGS_YEMOT_API_BASE || "https://www.call2all.co.il/ym/api").replace(/\/$/, "");
const RECORDINGS_FOLDER = String(process.env.RECORDINGS_FOLDER || "").trim().replace(/\/$/, "");
const PORT = process.env.PORT || 3000;
const POST_VOTE_TRANSFER = String(process.env.POST_VOTE_TRANSFER || "").replace(/\D/g, "");
const REQUEST_TIMEOUT_MS = 8000;
if (!SITE_API_BASE_URL) { console.error("חסר SITE_API_BASE_URL"); process.exit(1); }
if (!IVR_SECRET) { console.error("חסר IVR_SECRET"); process.exit(1); }

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

async function api(path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  const retries = method === "GET" || method === "HEAD" ? MAX_RETRIES : 0;
  const logPath = new URL(path, "http://ivr.local").pathname;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "x-ivr-secret": IVR_SECRET, ...fetchOptions.headers };
      const response = await fetch(`${SITE_API_BASE_URL}${path}`, { ...fetchOptions, headers, signal: controller.signal });
      const raw = await response.text();
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error(`site api returned ${response.status} instead of json`); }
      return { response, result };
    } catch (error) {
      lastError = error;
      clearTimeout(timer);
      if (attempt < retries) { console.error(`IVR api retry ${attempt + 1} for ${logPath}:`, error.message); continue; }
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

function text(data) { return { type: "text", data }; }
function number(data) { return { type: "digits", data: String(data) }; }
function file(data) { return { type: "file", data }; }
function finishCall(call) { return POST_VOTE_TRANSFER ? call.routing_yemot(POST_VOTE_TRANSFER) : call.hangup(); }

function promptMap(catalog) { return new Map((catalog.ivrPrompts || []).filter((item) => item?.key).map((item) => [item.key, item])); }
function prompt(prompts, key, fallback) {
  const item = prompts.get(key);
  return item?.yemotPath ? [file(item.yemotPath)] : [text(fallback)];
}
function itemPrompt(prompts, kind, item, label) {
  const nameOnly = prompts.get(`${kind}-name:${item.id}`);
  if (nameOnly?.yemotPath) return [file(nameOnly.yemotPath)];
  return [text(`${label} ${item.title || item.name}`)];
}

// Individual recordings contain only the item name. The keypad code is added
// by the IVR so the same recording also works in fixed-width long menus.
const KINDS_MISSING_DIGIT = new Set(["album", "song", "artist"]);

async function chooseOne(call, messages, items, label, kind, prompts, menuPromptKey = "", allowFinish = false) {
  if (!items.length) return null;
  const input = continuousMenuInput(items.length, allowFinish);
  const full = [...messages];
  const continuousMenu = menuPromptKey ? prompts.get(menuPromptKey) : null;
  if (continuousMenu?.yemotPath) {
    full.push(file(continuousMenu.yemotPath));
  } else {
    items.forEach((item, index) => {
      const recorded = prompts.get(`${kind}:${item.id}`);
      const code = menuCode(index, input.width);
      if (recorded?.yemotPath) {
        full.push(file(recorded.yemotPath));
        if (KINDS_MISSING_DIGIT.has(kind)) full.push(text("הקישו"), number(code));
      } else {
        full.push(text(`${label} ${item.title || item.name}`), text("הקישו"), number(code));
      }
    });
  }
  const answer = await call.read(full, "tap", input.read);
  if (allowFinish && answer === input.finishCode) return null;
  return items[Number(answer) - 1] || null;
}

// A list shorter than the requested amount (a song deactivated mid-poll, say)
// used to abort the call, and the caller stayed stuck there on every callback
// because the saved progress kept sending them back. Take whatever is there.
function quota(amount, available) { return Math.min(amount, available); }

async function chooseMany(call, intro, items, minimum, maximum, label, kind, prompts, menuPromptKey = "") {
  const minTarget = quota(minimum, items.length);
  const maxTarget = quota(maximum, items.length);
  if (!maxTarget) return [];
  const selected = [];
  const selectedIds = new Set();
  let lead = [];
  let showIntro = true;
  const hasRecordedMenu = Boolean(menuPromptKey && prompts.get(menuPromptKey)?.yemotPath);
  while (selected.length < maxTarget) {
    const canFinish = selected.length >= minTarget;
    const finishCode = "0".repeat(menuCodeWidth(items.length));
    const finishPrompt = canFinish
      ? (finishCode === "0" ? prompt(prompts, "system:finish_selection", "לסיום הבחירה הקישו 0") : [text(`לסיום הבחירה הקישו ${finishCode}`)])
      : [];
    const progressPrompt = hasRecordedMenu ? [] : [text(`בחירה ${selected.length + 1} מתוך עד ${maxTarget}`)];
    const messages = [...lead, ...(showIntro ? intro : []), ...progressPrompt, ...finishPrompt];
    lead = [];
    showIntro = false;
    const choice = await chooseOne(call, messages, items, label, kind, prompts, menuPromptKey, canFinish);
    if (!choice) break;
    if (selectedIds.has(choice.id)) {
      lead = prompt(prompts, "system:already_selected", "כבר הצבעתם לזה בחרו אפשרות אחרת");
      continue;
    }
    selected.push(choice);
    selectedIds.add(choice.id);
  }
  return selected;
}

function promptFileName(key) {
  return `rb${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

async function adminChoice(call, intro, items) {
  if (!items.length) return null;
  const back = items.find((item) => item.digit === 0) || null;
  const choices = items.filter((item) => item.digit !== 0);
  if (choices.length <= 9) {
    const messages = [text(intro)];
    choices.forEach((item) => messages.push(text(item.label), text("הקישו"), number(item.digit)));
    if (back) messages.push(text(back.label), text("הקישו 0"));
    const digits = choices.map((item) => item.digit);
    if (back) digits.push(0);
    const answer = await call.read(messages, "tap", menuReadOptions(digits));
    return items.find((item) => String(item.digit) === String(answer)) || null;
  }

  const input = continuousMenuInput(choices.length, Boolean(back));
  const messages = [text(intro)];
  choices.forEach((item, index) => messages.push(text(item.label), text("הקישו"), number(menuCode(index, input.width))));
  if (back) messages.push(text(back.label), text("הקישו"), number(input.finishCode));
  const answer = await call.read(messages, "tap", input.read);
  if (back && answer === input.finishCode) return back;
  return choices[Number(answer) - 1] || null;
}

async function menuRecordingTarget(_call, baseKey, label, items) {
  const width = menuCodeWidth(items.length);
  if (width === 1) return { key: baseKey, label };
  const firstCode = menuCode(0, width);
  const lastCode = menuCode(items.length - 1, width);
  return { key: baseKey, label: `${label}, בקובץ אחד, עם קודים בני ${width} ספרות מ ${firstCode} עד ${lastCode}` };
}

async function downloadRecordedAudio(fileName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const url = new URL(`${RECORDINGS_YEMOT_API_BASE}/DownloadFile`);
    url.searchParams.set("token", RECORDINGS_YEMOT_TOKEN);
    url.searchParams.set("path", `ivr2:${RECORDINGS_FOLDER}/${fileName}.wav`);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`recording download failed with ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > 25 * 1024 * 1024) throw new Error("recording size is invalid");
    const contentType = response.headers.get("content-type") || "audio/wav";
    if (contentType.includes("json")) {
      const message = new TextDecoder().decode(buffer);
      throw new Error(`recording download returned an error: ${message.slice(0, 160)}`);
    }
    return new Blob([buffer], { type: contentType.startsWith("audio/") ? contentType : "audio/wav" });
  } finally {
    clearTimeout(timer);
  }
}

async function recordPromptByPhone(call, callerPhone, key, label) {
  const fileName = promptFileName(key);
  await call.read(
    [text(`הקליטו כעת ${label} לסיום הקישו סולמית ולאחר מכן אשרו את ההקלטה`)],
    "record",
    {
      path: RECORDINGS_FOLDER,
      file_name: fileName,
      no_confirm_menu: false,
      save_on_hangup: false,
      max_length: 900,
    },
  );
  const audio = await downloadRecordedAudio(fileName);
  const form = new FormData();
  form.set("key", key);
  form.set("label", label);
  form.set("phone", callerPhone);
  form.set("file", audio, `${fileName}.wav`);
  const { response, result } = await api("/api/ivr/prompt", {
    method: "POST",
    body: form,
    timeoutMs: 60000,
  });
  if (!response.ok || !result?.ok) throw new Error(result?.error || "prompt transfer failed");
  return result.prompt;
}

const router = YemotRouter({
  printLog: true,
  defaults: { removeInvalidChars: true, read: { removeInvalidChars: true }, id_list_message: { removeInvalidChars: true } },
  uncaughtErrorHandler: async (error, call) => {
    console.error("IVR error", error);
    try { call.id_list_message([text("אירעה שגיאה במערכת. נא לנסות שוב מאוחר יותר.")]); } catch {}
  },
});

async function loadProgress(voterPhone) {
  try {
    const { result } = await api(`/api/ballots/progress?voterKey=${encodeURIComponent(voterPhone)}`);
    return result?.progress || null;
  } catch { return null; }
}

async function saveProgress(voterPhone, data) {
  try {
    await api(`/api/ballots/progress?voterKey=${encodeURIComponent(voterPhone)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
    });
  } catch (error) { console.error("save progress error", error.message); }
}

async function clearProgress(voterPhone) {
  try {
    await api(`/api/ballots/progress?voterKey=${encodeURIComponent(voterPhone)}`, { method: "DELETE" });
  } catch {}
}

async function phoneAdminOverview(callerPhone) {
  const { response, result } = await api(`/api/ivr/admin/overview?phone=${encodeURIComponent(callerPhone)}`);
  if (!response.ok) throw new Error(result?.error || "לא ניתן לטעון את נתוני הניהול");
  return result;
}

async function phoneAdminAction(callerPhone, action) {
  const { response, result } = await api("/api/ivr/admin/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: callerPhone, ...action }),
  });
  if (!response.ok) throw new Error(result?.error || "פעולת הניהול נכשלה");
  return result;
}

async function confirmAction(call, messages) {
  const content = Array.isArray(messages) ? [...messages] : [text(messages)];
  content.push(text("לאישור הקישו 1 לביטול הקישו 0"));
  const answer = await call.read(content, "tap", menuReadOptions([0, 1]));
  return String(answer) === "1";
}

async function readNumberWithHash(call, message, maxDigits = 2) {
  const answer = await call.read([text(message), text("לסיום הקישו סולמית לביטול הקישו 0 וסולמית")], "tap", {
    min_digits: 1,
    max_digits: maxDigits,
    typing_playback_mode: "No",
  });
  return String(answer || "");
}

// ---------- קו הניהול ----------
// כל פעולה כאן היא קוד קבוע בן שתי ספרות מתוך admin-menu.js, ואפשר להקיש אותו
// מכל תפריט. אחרי כל פעולה חוזרים לרשימת הנושא שממנו הגיעו, כדי שאפשר יהיה
// לבצע כמה פעולות באותו נושא בלי לנווט מחדש.

async function speakBack(call, messages) {
  const content = Array.isArray(messages) ? [...messages] : [text(messages)];
  content.push(text("לחזרה הקישו 0"));
  await call.read(content, "tap", menuReadOptions([0]));
}

async function pickItem(call, intro, items, toLabel) {
  if (!items.length) {
    await speakBack(call, "הרשימה ריקה");
    return null;
  }
  return adminChoice(call, intro, [
    ...items.map((item, index) => ({ ...item, digit: index + 1, label: toLabel(item, index) })),
    { digit: 0, id: "", key: "", email: "", label: "לחזרה" },
  ]);
}

async function pickAlbum(call, state, intro = "בחרו אלבום") {
  return pickItem(call, intro, state.albums || [], (album) => `${album.title}${album.active ? "" : ", מושבת"}`);
}

async function pickSong(call, state, intro = "בחרו שיר") {
  const album = await pickAlbum(call, state);
  if (!album?.id) return null;
  const songs = (state.songs || []).filter((song) => song.albumId === album.id);
  if (!songs.length) return { empty: true, album };
  const song = await pickItem(call, intro, songs, (item) => `${item.title}${item.active ? "" : ", מושבת"}`);
  return song?.id ? { ...song, album } : null;
}

async function pickAnyItem(call, state, intro = "בחרו פריט") {
  const kind = await adminChoice(call, "בחרו סוג פריט", [
    { digit: 1, kind: "album", label: "אלבום" },
    { digit: 2, kind: "song", label: "שיר" },
    { digit: 3, kind: "artist", label: "זמר" },
    { digit: 0, kind: "", label: "לחזרה" },
  ]);
  if (!kind?.kind) return null;
  if (kind.kind === "album") {
    const album = await pickAlbum(call, state, intro);
    return album?.id ? { kind: "album", id: album.id, label: album.title, active: album.active } : null;
  }
  if (kind.kind === "artist") {
    const artist = await pickItem(call, intro, state.artists || [], (item) => `${item.name}${item.active ? "" : ", מושבת"}`);
    return artist?.id ? { kind: "artist", id: artist.id, label: artist.name, active: artist.active } : null;
  }
  const song = await pickSong(call, state, intro);
  if (song?.empty) return { empty: true };
  return song?.id ? { kind: "song", id: song.id, label: song.title, active: song.active } : null;
}

function hasPrompt(state, key) {
  return (state.prompts || []).some((item) => item.key === key && item.yemotPath);
}

async function chooseRecordingTarget(call, state, kind) {
  const surveyId = state.activeSurvey.id;
  if (kind === "system") {
    return pickItem(call, "בחרו הודעת מערכת", RECORDABLE_SYSTEM_PROMPTS, (item) => item.label);
  }
  if (kind === "albums") {
    const fullMenuKey = `albums-menu:${surveyId}`;
    const mode = await adminChoice(call, "בחרו סוג קריינות לאלבומים", [
      { digit: 1, key: fullMenuKey, label: "כל רשימת האלבומים ומספרי ההקשה ברצף" },
      ...(!hasPrompt(state, fullMenuKey) ? [{ digit: 2, key: "", label: "אלבום בודד" }] : []),
      { digit: 0, key: "", label: "לחזרה" },
    ]);
    if (mode?.digit === 1) return menuRecordingTarget(call, mode.key, "רשימת האלבומים ומספרי ההקשה", state.albums || []);
    if (mode?.digit === 2) {
      const album = await pickAlbum(call, state);
      if (album?.id) return { key: `album:${album.id}`, label: `שם האלבום ${album.title}` };
    }
    return null;
  }
  if (kind === "songs") {
    const album = await pickAlbum(call, state);
    if (!album?.id) return null;
    const songs = (state.songs || []).filter((song) => song.albumId === album.id);
    const fullSongsKey = `songs-menu:${album.id}`;
    const target = await adminChoice(call, `בחרו קריינות עבור האלבום ${album.title}`, [
      { digit: 1, key: `album-name:${album.id}`, label: "שם האלבום לפני בחירת השירים" },
      { digit: 2, key: fullSongsKey, label: "כל השירים ומספרי ההקשה ברצף" },
      ...(!hasPrompt(state, fullSongsKey) ? [{ digit: 3, key: "", label: "שיר בודד" }] : []),
      { digit: 0, key: "", label: "לחזרה" },
    ]);
    if (target?.digit === 2) return menuRecordingTarget(call, target.key, `רשימת השירים ומספרי ההקשה של ${album.title}`, songs);
    if (target?.digit === 1) return { key: target.key, label: `שם האלבום ${album.title}` };
    if (target?.digit === 3) {
      const song = await pickItem(call, "בחרו שיר", songs, (item) => item.title);
      if (song?.id) return { key: `song:${song.id}`, label: `שם השיר ${song.title}` };
    }
    return null;
  }
  const fullMenuKey = `artists-menu:${surveyId}`;
  const mode = await adminChoice(call, "בחרו סוג קריינות לזמרים", [
    { digit: 1, key: fullMenuKey, label: "כל רשימת הזמרים ומספרי ההקשה ברצף" },
    ...(!hasPrompt(state, fullMenuKey) ? [{ digit: 2, key: "", label: "זמר בודד" }] : []),
    { digit: 0, key: "", label: "לחזרה" },
  ]);
  if (mode?.digit === 1) return menuRecordingTarget(call, mode.key, "רשימת הזמרים ומספרי ההקשה", state.artists || []);
  if (mode?.digit === 2) {
    const artist = await pickItem(call, "בחרו זמר", state.artists || [], (item) => item.name);
    if (artist?.id) return { key: `artist:${artist.id}`, label: `שם הזמר ${artist.name}` };
  }
  return null;
}

// הקריינות האוטומטית קוראת את השם השמור באתר, ולכן היא מוצעת רק לקריינות של פריט.
const TTS_PROMPT_KINDS = new Set(["album", "album-name", "artist", "song"]);

async function managePrompt(call, callerPhone, target, state) {
  const current = (state.prompts || []).find((item) => item.key === target.key);
  const ttsReady = Boolean(state.services?.tts) && TTS_PROMPT_KINDS.has(String(target.key).split(":")[0]);
  const action = await adminChoice(call, `${target.label}. ${current ? "קיימת קריינות מוקלטת" : "עדיין אין קריינות מוקלטת"}`, [
    { digit: 1, label: current ? "להחלפת הקריינות" : "להקלטת קריינות" },
    ...(current?.yemotPath ? [{ digit: 2, label: "להשמעת הקריינות הקיימת" }] : []),
    ...(current ? [{ digit: 3, label: "למחיקת הקריינות" }] : []),
    ...(ttsReady ? [{ digit: 4, label: "ליצירת קריינות אוטומטית מהשם הכתוב" }] : []),
    { digit: 0, label: "לחזרה" },
  ]);
  if (!action || action.digit === 0) return "חזרתם לתפריט הקריינויות";
  if (action.digit === 1) {
    await recordPromptByPhone(call, callerPhone, target.key, target.label);
    return "הקריינות נשמרה והיא פעילה בקו ההצבעה";
  }
  if (action.digit === 2 && current?.yemotPath) {
    await speakBack(call, [file(current.yemotPath)]);
    return "השמעת הקריינות הסתיימה";
  }
  if (action.digit === 3 && current) {
    if (!(await confirmAction(call, `האם למחוק את הקריינות של ${target.label}`))) return "המחיקה בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "delete-prompt", key: target.key })).message;
  }
  if (action.digit === 4) {
    return (await phoneAdminAction(callerPhone, { action: "generate-tts", key: target.key })).message;
  }
  return "חזרתם לתפריט הקריינויות";
}

async function promptFlow(call, callerPhone, kind) {
  const state = await phoneAdminOverview(callerPhone);
  const target = await chooseRecordingTarget(call, state, kind);
  if (!target?.key) return "חזרתם לתפריט הקריינויות";
  return managePrompt(call, callerPhone, target, state);
}

function missingPrompts(state) {
  const missing = [];
  for (const album of state.albums || []) if (!hasPrompt(state, `album:${album.id}`)) missing.push(`האלבום ${album.title}`);
  for (const artist of state.artists || []) if (!hasPrompt(state, `artist:${artist.id}`)) missing.push(`הזמר ${artist.name}`);
  for (const song of state.songs || []) if (!hasPrompt(state, `song:${song.id}`)) missing.push(`השיר ${song.title}`);
  return missing;
}

async function createItemFlow(call, callerPhone, kind) {
  const nouns = { album: "אלבום", song: "שיר", artist: "זמר" };
  const state = await phoneAdminOverview(callerPhone);
  let albumId = "";
  if (kind === "song") {
    const album = await pickAlbum(call, state, "בחרו את האלבום שאליו יתווסף השיר");
    if (!album?.id) return "הוספת השיר בוטלה";
    albumId = album.id;
  }
  if (!(await confirmAction(call, `האם להוסיף ${nouns[kind]} חדש. הוא ייווצר מושבת עם שם זמני שאפשר לשנות באתר`))) return "ההוספה בוטלה";
  const created = await phoneAdminAction(callerPhone, { action: "create-item", kind, albumId });
  if (await confirmAction(call, `האם להקליט עכשיו את שם ה${nouns[kind]} לקו`)) {
    await recordPromptByPhone(call, callerPhone, created.promptKey, `שם ה${nouns[kind]}`);
  }
  if (await confirmAction(call, `האם להפעיל את ה${nouns[kind]} בהצבעה`)) {
    await phoneAdminAction(callerPhone, { action: "toggle-item", kind, id: created.id, value: true });
    return `${created.title} נוסף והופעל`;
  }
  return created.message;
}

async function topResults(call, callerPhone, key, label) {
  const state = await phoneAdminOverview(callerPhone);
  const rows = (state.results && state.results[key]) || [];
  if (!rows.length) return `אין עדיין תוצאות ל${label}`;
  const messages = [text(`${label} מובילים`)];
  rows.forEach((item, index) => messages.push(text(`מקום ${index + 1}. ${item.label}. ${Number(item.votes || 0)} הצבעות`)));
  await speakBack(call, messages);
  return "חזרתם לתפריט מצב ותוצאות";
}

async function archiveFlow(call, callerPhone, mode) {
  const state = await phoneAdminOverview(callerPhone);
  const archives = state.archives || [];
  if (!archives.length) return "אין גיבויים בארכיון";
  const archive = await pickItem(call, mode === "restore" ? "בחרו גיבוי לשחזור" : "בחרו גיבוי למחיקה", archives, (item) => `${item.name}, ${item.votes} הצבעות`);
  if (!archive?.key) return "חזרתם לתפריט הגיבויים";
  if (mode === "restore") {
    if (!(await confirmAction(call, `האם לשחזר את הגיבוי ${archive.name}. המצב הנוכחי יגובה אוטומטית`))) return "השחזור בוטל";
    return (await phoneAdminAction(callerPhone, { action: "restore-archive", key: archive.key })).message;
  }
  if (!(await confirmAction(call, `האם למחוק לצמיתות את הגיבוי ${archive.name}`))) return "מחיקת הגיבוי בוטלה";
  return (await phoneAdminAction(callerPhone, { action: "delete-archive", key: archive.key })).message;
}

const ADMIN_ACTIONS = {
  "prompt-system": (call, callerPhone) => promptFlow(call, callerPhone, "system"),
  "prompt-albums": (call, callerPhone) => promptFlow(call, callerPhone, "albums"),
  "prompt-songs": (call, callerPhone) => promptFlow(call, callerPhone, "songs"),
  "prompt-artists": (call, callerPhone) => promptFlow(call, callerPhone, "artists"),

  "tts-item": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    if (!state.services?.tts) return "שירות הקריינות האוטומטית אינו מוגדר";
    const item = await pickAnyItem(call, state, "בחרו פריט לקריינות אוטומטית");
    if (item?.empty) return "אין שירים באלבום שנבחר";
    if (!item?.id) return "חזרתם לתפריט הקריינויות";
    if (!(await confirmAction(call, `האם ליצור קריינות אוטומטית עבור ${item.label}`))) return "היצירה בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "generate-tts", key: `${item.kind}:${item.id}` })).message;
  },

  "tts-missing": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    if (!state.services?.tts) return "שירות הקריינות האוטומטית אינו מוגדר";
    const missing = missingPrompts(state);
    if (!missing.length) return "לכל הפריטים כבר יש קריינות";
    if (!(await confirmAction(call, `חסרות ${missing.length} קריינויות. האם ליצור אותן אוטומטית`))) return "היצירה בוטלה";
    let created = 0, remaining = missing.length;
    while (remaining > 0) {
      const result = await phoneAdminAction(callerPhone, { action: "generate-missing-tts", limit: 20 });
      created += Number(result.created || 0);
      remaining = Number(result.remaining || 0);
      if (!Number(result.created || 0)) break;
    }
    return remaining ? `נוצרו ${created} קריינויות ונשארו ${remaining}` : `נוצרו ${created} קריינויות ולכל הפריטים יש קריינות`;
  },

  "prompts-missing": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const missing = missingPrompts(state);
    if (!missing.length) return "לכל הפריטים יש קריינות מוקלטת";
    const messages = [text(`חסרות ${missing.length} קריינויות`)];
    missing.slice(0, 20).forEach((label) => messages.push(text(label)));
    if (missing.length > 20) messages.push(text(`ועוד ${missing.length - 20} פריטים`));
    await speakBack(call, messages);
    return "חזרתם לתפריט הקריינויות";
  },

  "voting-open": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    if (state.settings.votingOpen) return "ההצבעה כבר פתוחה";
    if (!state.readiness.ready) return `אי אפשר לפתוח את ההצבעה. ${state.readiness.warnings.join(". ")}`;
    if (!(await confirmAction(call, `האם לפתוח את ההצבעה בסקר ${state.activeSurvey.name}`))) return "השינוי בוטל";
    return (await phoneAdminAction(callerPhone, { action: "set-voting-open", value: true })).message;
  },

  "voting-close": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    if (!state.settings.votingOpen) return "ההצבעה כבר סגורה";
    if (!(await confirmAction(call, `האם לסגור את ההצבעה בסקר ${state.activeSurvey.name}`))) return "השינוי בוטל";
    return (await phoneAdminAction(callerPhone, { action: "set-voting-open", value: false })).message;
  },

  "voting-readiness": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const counts = state.readiness.counts;
    await speakBack(call, [text(`אלבומים פעילים ${counts.albums}. שירים פעילים ${counts.songs}. זמרים פעילים ${counts.artists}. ${state.readiness.ready ? "הסקר מוכן להצבעה" : state.readiness.warnings.join(". ")}`)]);
    return "חזרתם לתפריט ההצבעה";
  },

  "voting-reset": async (call, callerPhone) => {
    if (!(await confirmAction(call, "האם למחוק לצמיתות את כל ההצבעות בסקר הפעיל"))) return "איפוס ההצבעות בוטל";
    return (await phoneAdminAction(callerPhone, { action: "reset-votes" })).message;
  },

  "survey-activate": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const survey = await pickItem(call, "בחרו סקר להפעלה", state.surveys || [], (item) => `${item.name}${item.active ? ", פעיל כעת" : ""}`);
    if (!survey?.id) return "חזרתם לתפריט הסקרים";
    if (survey.active) return "הסקר שבחרתם כבר פעיל";
    if (!(await confirmAction(call, `האם להפעיל את הסקר ${survey.name}`))) return "הפעלת הסקר בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "activate-survey", id: survey.id })).message;
  },

  "survey-create": async (call, callerPhone) => {
    if (!(await confirmAction(call, "האם ליצור סקר חדש כטיוטה עם שם אוטומטי"))) return "יצירת הסקר בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "create-survey" })).message;
  },

  "survey-delete": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const survey = await pickItem(call, "בחרו סקר למחיקה", (state.surveys || []).filter((item) => !item.active), (item) => item.name);
    if (!survey?.id) return "חזרתם לתפריט הסקרים";
    if (!(await confirmAction(call, `האם למחוק לצמיתות את הסקר ${survey.name}`))) return "מחיקת הסקר בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "delete-survey", id: survey.id })).message;
  },

  "survey-list": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const messages = [text(`יש ${(state.surveys || []).length} סקרים`)];
    (state.surveys || []).forEach((item) => messages.push(text(`${item.name}. ${item.active ? "פעיל" : "טיוטה"}. ההצבעה ${item.votingOpen ? "פתוחה" : "סגורה"}`)));
    await speakBack(call, messages);
    return "חזרתם לתפריט הסקרים";
  },

  "stage-toggle": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const stage = await pickStage(call, state);
    if (!stage?.key) return "חזרתם לתפריט השלבים";
    if (!(await confirmAction(call, `האם ${stage.enabled ? "לכבות" : "להפעיל"} את שלב ${stage.label}`))) return "השינוי בוטל";
    return (await phoneAdminAction(callerPhone, { action: "set-stage-enabled", stage: stage.key, value: !stage.enabled })).message;
  },

  "stage-quota": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const stage = await pickStage(call, state);
    if (!stage?.key) return "חזרתם לתפריט השלבים";
    const minimum = Number(await readNumberWithHash(call, `הקישו את מספר הבחירות המינימלי עבור ${stage.label}`));
    if (!minimum) return "השינוי בוטל";
    const maximum = Number(await readNumberWithHash(call, `הקישו את מספר הבחירות המקסימלי עבור ${stage.label}`));
    if (!maximum) return "השינוי בוטל";
    if (!(await confirmAction(call, [text(`המינימום יהיה ${minimum} והמקסימום יהיה ${maximum}`)]))) return "השינוי בוטל";
    return (await phoneAdminAction(callerPhone, { action: "set-quota", stage: stage.key, min: minimum, max: maximum })).message;
  },

  "stage-list": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    await speakBack(call, stageList(state).map((stage) => text(`${stage.label}. ${stage.enabled ? "פעיל" : "כבוי"}. מינימום ${stage.min}. מקסימום ${stage.max}`)));
    return "חזרתם לתפריט השלבים";
  },

  "item-create-album": (call, callerPhone) => createItemFlow(call, callerPhone, "album"),
  "item-create-song": (call, callerPhone) => createItemFlow(call, callerPhone, "song"),
  "item-create-artist": (call, callerPhone) => createItemFlow(call, callerPhone, "artist"),

  "item-toggle": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const item = await pickAnyItem(call, state, "בחרו פריט להפעלה או להשבתה");
    if (item?.empty) return "אין שירים באלבום שנבחר";
    if (!item?.id) return "חזרתם לתפריט התוכן";
    const nextActive = !item.active;
    if (!(await confirmAction(call, `האם ${nextActive ? "להפעיל" : "להשבית"} את ${item.label}`))) return "השינוי בוטל";
    return (await phoneAdminAction(callerPhone, { action: "toggle-item", kind: item.kind, id: item.id, value: nextActive })).message;
  },

  "item-move": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const item = await pickAnyItem(call, state, "בחרו פריט להזזה");
    if (item?.empty) return "אין שירים באלבום שנבחר";
    if (!item?.id) return "חזרתם לתפריט התוכן";
    const direction = await adminChoice(call, `הזזת ${item.label}`, [
      { digit: 1, value: -1, label: "למעלה" },
      { digit: 2, value: 1, label: "למטה" },
      { digit: 0, value: 0, label: "לחזרה" },
    ]);
    if (!direction?.value) return "חזרתם לתפריט התוכן";
    return (await phoneAdminAction(callerPhone, { action: "move-item", kind: item.kind, id: item.id, direction: direction.value })).message;
  },

  "item-position": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const item = await pickAnyItem(call, state, "בחרו פריט להעברה");
    if (item?.empty) return "אין שירים באלבום שנבחר";
    if (!item?.id) return "חזרתם לתפריט התוכן";
    const position = Number(await readNumberWithHash(call, `הקישו את המקום החדש של ${item.label}`));
    if (!position) return "ההעברה בוטלה";
    if (!(await confirmAction(call, `האם להעביר את ${item.label} למקום ${position}`))) return "ההעברה בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "set-position", kind: item.kind, id: item.id, position })).message;
  },

  "item-delete": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const item = await pickAnyItem(call, state, "בחרו פריט למחיקה");
    if (item?.empty) return "אין שירים באלבום שנבחר";
    if (!item?.id) return "חזרתם לתפריט התוכן";
    if (!(await confirmAction(call, `האם למחוק לצמיתות את ${item.label}`))) return "המחיקה בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "delete-item", kind: item.kind, id: item.id })).message;
  },

  "item-preview": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const song = await pickSong(call, state, "בחרו שיר לקביעת קטע ההשמעה");
    if (song?.empty) return "אין שירים באלבום שנבחר";
    if (!song?.id) return "חזרתם לתפריט התוכן";
    const mode = await adminChoice(call, `קטע ההשמעה של ${song.title} מתחיל בשנייה ${Number(song.previewStart || 0)} ומסתיים בשנייה ${Number(song.previewEnd || 0)}`, [
      { digit: 1, label: "להקשת זמן התחלה וסיום" },
      ...(state.services?.ai && song.audioUrl ? [{ digit: 2, label: "להתאמה אוטומטית לפי הפזמון" }] : []),
      { digit: 0, label: "לחזרה" },
    ]);
    if (mode?.digit === 2) return (await phoneAdminAction(callerPhone, { action: "suggest-preview", id: song.id })).message;
    if (mode?.digit !== 1) return "חזרתם לתפריט התוכן";
    const start = Number(await readNumberWithHash(call, "הקישו את שניית ההתחלה", 3));
    const end = Number(await readNumberWithHash(call, "הקישו את שניית הסיום", 3));
    if (!end) return "השינוי בוטל";
    if (!(await confirmAction(call, [text(`הקטע יתחיל בשנייה ${start} ויסתיים בשנייה ${end}`)]))) return "השינוי בוטל";
    return (await phoneAdminAction(callerPhone, { action: "set-preview", id: song.id, start, end })).message;
  },

  "item-covers": async (call, callerPhone) => {
    if (!(await confirmAction(call, "האם לחלץ עטיפות מקובצי השמע של השירים"))) return "החילוץ בוטל";
    return (await phoneAdminAction(callerPhone, { action: "extract-covers" })).message;
  },

  "access-add-recorder": async (call, callerPhone) => {
    const raw = await readNumberWithHash(call, "הקישו את מספר הטלפון המלא", 12);
    if (raw === "0") return "הוספת המספר בוטלה";
    const targetPhone = normalizePhone(raw);
    if (!targetPhone) return "מספר הטלפון שהוקש אינו תקין";
    if (!(await confirmAction(call, [text("המספר שהוקש הוא"), number(targetPhone)]))) return "הוספת המספר בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "add-recorder", targetPhone })).message;
  },

  "access-remove-recorder": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const target = await pickItem(call, "בחרו מספר להסרת הרשאה", (state.recorders || []).map((item) => ({ phone: item })), (item) => item.phone);
    if (!target?.phone) return "חזרתם לתפריט ההרשאות";
    if (!(await confirmAction(call, [text("האם להסיר את ההרשאה של המספר"), number(target.phone)]))) return "הסרת ההרשאה בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "remove-recorder", targetPhone: target.phone })).message;
  },

  "access-list-recorders": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const messages = [text(`יש ${(state.recorders || []).length} מספרים מורשים לנהל ולהקליט`)];
    (state.recorders || []).forEach((item) => messages.push(number(item)));
    await speakBack(call, messages);
    return "חזרתם לתפריט ההרשאות";
  },

  "access-list-managers": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const managers = state.managers || [];
    const messages = [text(`יש ${managers.length} מנהלי אתר`)];
    managers.forEach((email, index) => messages.push(text(`מנהל מספר ${index + 1}. ${email}`)));
    messages.push(text("הוספת מנהל אתר נעשית באתר בלבד"));
    await speakBack(call, messages);
    return "חזרתם לתפריט ההרשאות";
  },

  "access-remove-manager": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const manager = await pickItem(call, "בחרו מנהל אתר להסרה", (state.managers || []).map((email) => ({ email })), (item, index) => `מנהל מספר ${index + 1}. ${item.email}`);
    if (!manager?.email) return "חזרתם לתפריט ההרשאות";
    if (!(await confirmAction(call, `האם להסיר את ההרשאה של ${manager.email}`))) return "ההסרה בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "remove-manager", email: manager.email })).message;
  },

  "status-summary": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const counts = state.readiness.counts;
    await speakBack(call, [text(`הסקר הפעיל ${state.activeSurvey.name}. ההצבעה ${state.settings.votingOpen ? "פתוחה" : "סגורה"}. התקבלו ${Number(state.votes.total || 0)} הצבעות, מתוכן ${Number(state.votes.phone || 0)} בטלפון ו ${Number(state.votes.site || 0)} באתר. אלבומים פעילים ${counts.albums}. שירים פעילים ${counts.songs}. זמרים פעילים ${counts.artists}. ${state.readiness.ready ? "הסקר מוכן" : state.readiness.warnings.join(". ")}`)]);
    return "חזרתם לתפריט המצב";
  },

  "status-albums": (call, callerPhone) => topResults(call, callerPhone, "albums", "אלבומים"),
  "status-songs": (call, callerPhone) => topResults(call, callerPhone, "songs", "שירים"),
  "status-artists": (call, callerPhone) => topResults(call, callerPhone, "artists", "זמרים"),

  "archive-create": async (call, callerPhone) => {
    if (!(await confirmAction(call, "האם ליצור עכשיו גיבוי מלא כולל קובצי המדיה"))) return "יצירת הגיבוי בוטלה";
    return (await phoneAdminAction(callerPhone, { action: "create-archive" })).message;
  },

  "archive-restore": (call, callerPhone) => archiveFlow(call, callerPhone, "restore"),
  "archive-delete": (call, callerPhone) => archiveFlow(call, callerPhone, "delete"),

  "archive-list": async (call, callerPhone) => {
    const state = await phoneAdminOverview(callerPhone);
    const archives = state.archives || [];
    const messages = [text(`יש ${archives.length} גיבויים בארכיון`)];
    archives.slice(0, 20).forEach((item, index) => messages.push(text(`גיבוי מספר ${index + 1}. ${item.name}. ${item.votes} הצבעות`)));
    await speakBack(call, messages);
    return "חזרתם לתפריט הגיבויים";
  },

  "help-map": async (call) => {
    const messages = [text("מפת קודי הניהול. אפשר להקיש כל קוד מכל תפריט")];
    ADMIN_SECTIONS.forEach((section) => {
      messages.push(text(section.label), text("הקישו"), number(section.code));
      section.items.forEach((item) => messages.push(text(item.label), text("הקישו"), number(item.code)));
    });
    messages.push(text("לתפריט הראשי הקישו 00. לסיום הקישו 99"));
    await speakBack(call, messages);
    return "חזרתם לתפריט הראשי";
  },

  "help-main": async () => "תפריט ראשי",
};

function stageList(state) {
  return [
    { key: "albums", label: "אלבומים", enabled: state.settings.albumsEnabled, min: state.settings.albumsMin, max: state.settings.albumsMax },
    { key: "songs", label: "שירים", enabled: state.settings.songsEnabled, min: state.settings.songsMin, max: state.settings.songsMax },
    { key: "artists", label: "זמרים", enabled: state.settings.artistsEnabled, min: state.settings.artistsMin, max: state.settings.artistsMax },
  ];
}

async function pickStage(call, state) {
  return adminChoice(call, "בחרו שלב", [
    ...stageList(state).map((stage, index) => ({ ...stage, digit: index + 1, label: `${stage.label}, ${stage.enabled ? "פעיל" : "כבוי"}, מינימום ${stage.min}, מקסימום ${stage.max}` })),
    { digit: 0, key: "", label: "לחזרה" },
  ]);
}

async function readAdminCode(call, lead, section) {
  const messages = [text(lead)];
  if (section) {
    messages.push(text(section.label));
    section.items.forEach((item) => messages.push(text(item.label), text("הקישו"), number(item.code)));
    messages.push(text("לתפריט הראשי הקישו 00"));
  } else {
    messages.push(text("תפריט ניהול ראשי. אפשר להקיש קוד פעולה ישיר מכל מקום"));
    ADMIN_SECTIONS.forEach((sectionItem) => messages.push(text(sectionItem.label), text("הקישו"), number(sectionItem.code)));
  }
  messages.push(text("לסיום השיחה הקישו 99"));
  return String(await call.read(messages, "tap", adminReadOptions()) || "");
}

router.get("/recordings", async (call) => {
  if (!RECORDINGS_YEMOT_TOKEN || !/^\/(?:\d+\/)*\d+$/.test(RECORDINGS_FOLDER)) {
    return call.id_list_message([text("קו הניהול וההקלטות עדיין אינו מוגדר")]);
  }

  const callerPhone = phone(call);
  const access = await api(`/api/ivr/recorders/check?phone=${encodeURIComponent(callerPhone)}`);
  if (!access.response.ok || !access.result?.allowed) {
    call.id_list_message([text("מספר הטלפון שלכם אינו מורשה לניהול ולהקלטת קריינויות")], { prependToNextAction: true });
    return call.hangup();
  }

  let lead = "ברוכים הבאים לקו הניהול והקלטת הקריינויות";
  let section = null;
  while (true) {
    const chosen = resolveAdminCode(await readAdminCode(call, lead, section));
    if (chosen.type === "hangup") {
      call.id_list_message([text("להתראות")], { prependToNextAction: true });
      return call.hangup();
    }
    if (chosen.type === "main") {
      section = null;
      lead = "תפריט ראשי";
      continue;
    }
    if (chosen.type === "section") {
      section = chosen.section;
      lead = chosen.section.label;
      continue;
    }
    if (chosen.type !== "action") {
      lead = "הקוד שהוקש אינו מוכר";
      continue;
    }
    section = chosen.item.action === "help-main" ? null : chosen.section;
    try {
      lead = await ADMIN_ACTIONS[chosen.item.action](call, callerPhone);
    } catch (error) {
      console.error("phone admin IVR error", chosen.item.code, error);
      lead = error instanceof Error ? error.message : "פעולת הניהול נכשלה נא לנסות שוב";
    }
  }
});

router.get("/", async (call) => {
  const { response, result: catalog } = await api("/api/catalog");
  const prompts = promptMap(catalog);
  if (!response.ok || !catalog.rules?.votingOpen) return call.id_list_message(prompt(prompts, "system:voting_closed", "ההצבעה עדיין אינה פתוחה"));

  const voterPhone = phone(call);
  if (!voterPhone) {
    call.id_list_message([text("לא ניתן להצביע ממספר חסוי נא להתקשר ממספר מזוהה ולנסות שוב")], { prependToNextAction: true });
    return call.hangup();
  }
  try {
    const { result: check } = await api(`/api/ballots/check?voterKey=${encodeURIComponent(voterPhone)}`);
    if (check.voted) {
      call.id_list_message(prompt(prompts, "system:already_voted", "כבר הצבעתם במצעד ממספר זה תודה"), { prependToNextAction: true });
      return finishCall(call);
    }
  } catch {}

  const rules = catalog.rules;
  const albumMinimum = rules.albumsEnabled ? rules.albumsMin : 0;
  const albumMaximum = rules.albumsEnabled ? rules.albumsMax : 0;
  const songMinimum = rules.songsEnabled ? rules.songsMin : 0;
  const songMaximum = rules.songsEnabled ? rules.songsMax : 0;
  const artistMinimum = rules.artistsEnabled ? rules.artistsMin : 0;
  const artistMaximum = rules.artistsEnabled ? rules.artistsMax : 0;
  const albumMenuKey = catalog.surveyId ? `albums-menu:${catalog.surveyId}` : "system:albums_menu";
  const artistMenuKey = catalog.surveyId ? `artists-menu:${catalog.surveyId}` : "system:artists_menu";
  if (rules.albumsEnabled && (!catalog.albums?.length || catalog.albums.length < albumMinimum)) return call.id_list_message(prompt(prompts, "system:not_ready", "רשימת האלבומים עדיין אינה מוכנה"));

  const saved = await loadProgress(voterPhone);
  let selectedAlbums = [], selectedArtists = [], songIdsByAlbum = {}, menuLead = [];

  if (saved) {
    const sanitized = sanitizeProgress(saved, catalog, rules);
    if (sanitized.albumIds.length) selectedAlbums = (catalog.albums || []).filter((a) => sanitized.albumIds.includes(a.id));
    songIdsByAlbum = sanitized.songIdsByAlbum;
    if (sanitized.artistIds.length) selectedArtists = (catalog.artists || []).filter((a) => sanitized.artistIds.includes(a.id));
    if (progressChanged(saved, sanitized)) await saveProgress(voterPhone, sanitized);
    menuLead = prompt(prompts, "system:welcome_back", "ברוכים השבים ממשיכים מאיפה שהפסקתם");
  }

  // These have to agree with what chooseMany can actually deliver, otherwise a
  // short list leaves the section permanently "not done" and the menu loops.
  const albumSongsOf = (album) => (catalog.songs || []).filter((song) => song.albumId === album.id);
  const albumMinQuota = quota(albumMinimum, (catalog.albums || []).length);
  const albumMaxQuota = quota(albumMaximum, (catalog.albums || []).length);
  const artistMinQuota = quota(artistMinimum, (catalog.artists || []).length);
  const artistMaxQuota = quota(artistMaximum, (catalog.artists || []).length);
  const songMinQuotaOf = (album) => quota(songMinimum, albumSongsOf(album).length);
  const songMaxQuotaOf = (album) => quota(songMaximum, albumSongsOf(album).length);

  const albumsDone = () => !rules.albumsEnabled || selectedAlbums.length >= albumMinQuota;
  const songsDone = () => !rules.songsEnabled || selectedAlbums.every((album) => (songIdsByAlbum[album.id] || []).length >= songMinQuotaOf(album));
  const artistsDone = () => !rules.artistsEnabled || selectedArtists.length >= artistMinQuota;
  const complete = () => albumsDone() && songsDone() && artistsDone();

  while (!complete()) {
    const allowed = [];
    if (rules.albumsEnabled && !albumsDone()) allowed.push(1);
    if (rules.songsEnabled && albumsDone() && !songsDone()) allowed.push(2);
    if (rules.artistsEnabled && !artistsDone()) allowed.push(3);
    if (!allowed.length) break;
    if (allowed.length === 1) {
      if (allowed[0] === 1) {
        selectedAlbums = await chooseMany(call, [...menuLead, ...prompt(prompts, "system:albums_intro", `בחרו בין ${albumMinQuota} ל ${albumMaxQuota} אלבומים`)], catalog.albums || [], albumMinimum, albumMaximum, "לאלבום", "album", prompts, albumMenuKey);
        songIdsByAlbum = {};
        menuLead = [];
        await saveProgress(voterPhone, { albumIds: selectedAlbums.map((a) => a.id), songIdsByAlbum, artistIds: selectedArtists.map((a) => a.id) });
        menuLead = prompt(prompts, "system:section_saved", "בחירת האלבומים נשמרה");
      } else if (allowed[0] === 2) {
        for (const album of selectedAlbums) {
          if ((songIdsByAlbum[album.id] || []).length >= songMinQuotaOf(album)) continue;
          const albumSongs = albumSongsOf(album);
          const intro = [...menuLead, ...prompt(prompts, "system:songs_intro", `בחרו בין ${songMinQuotaOf(album)} ל ${songMaxQuotaOf(album)} שירים מתוך האלבום`), ...itemPrompt(prompts, "album", album, "האלבום")];
          menuLead = [];
          const selectedSongs = await chooseMany(call, intro, albumSongs, songMinimum, songMaximum, "לשיר", "song", prompts, `songs-menu:${album.id}`);
          songIdsByAlbum[album.id] = selectedSongs.map((song) => song.id);
          await saveProgress(voterPhone, { albumIds: selectedAlbums.map((a) => a.id), songIdsByAlbum, artistIds: selectedArtists.map((a) => a.id) });
        }
        menuLead = prompt(prompts, "system:section_saved", "בחירת השירים נשמרה");
      } else {
        selectedArtists = await chooseMany(call, [...menuLead, ...prompt(prompts, "system:artists_intro", `בחרו בין ${artistMinQuota} ל ${artistMaxQuota} זמרים`)], catalog.artists || [], artistMinimum, artistMaximum, "לזמר", "artist", prompts, artistMenuKey);
        menuLead = [];
        await saveProgress(voterPhone, { albumIds: selectedAlbums.map((a) => a.id), songIdsByAlbum, artistIds: selectedArtists.map((a) => a.id) });
        menuLead = prompt(prompts, "system:section_saved", "בחירת הזמרים נשמרה");
      }
      continue;
    }
    const fallback = "לבחירת אלבומים הקישו 1 לבחירת שירים מתוך האלבומים שבחרתם הקישו 2 לבחירת זמרים הקישו 3";
    const answer = await call.read([...menuLead, ...prompt(prompts, "system:main_menu", fallback)], "tap", { min_digits: 1, max_digits: 1, digits_allowed: allowed, typing_playback_mode: "No" });
    menuLead = [];
    if (answer === "1" && rules.albumsEnabled) {
      selectedAlbums = await chooseMany(call, prompt(prompts, "system:albums_intro", `בחרו בין ${albumMinQuota} ל ${albumMaxQuota} אלבומים`), catalog.albums || [], albumMinimum, albumMaximum, "לאלבום", "album", prompts, albumMenuKey);
      songIdsByAlbum = {};
      await saveProgress(voterPhone, { albumIds: selectedAlbums.map((a) => a.id), songIdsByAlbum, artistIds: selectedArtists.map((a) => a.id) });
      menuLead = prompt(prompts, "system:section_saved", "בחירת האלבומים נשמרה חוזרים לתפריט הראשי");
    } else if (answer === "2" && rules.songsEnabled) {
      if (!selectedAlbums.length) { menuLead = prompt(prompts, "system:need_albums", "כדי לבחור שירים יש לבחור קודם אלבומים בשלוחה 1"); continue; }
      for (const album of selectedAlbums) {
        if ((songIdsByAlbum[album.id] || []).length >= songMinQuotaOf(album)) continue;
        const albumSongs = albumSongsOf(album);
        const intro = [...prompt(prompts, "system:songs_intro", `בחרו בין ${songMinQuotaOf(album)} ל ${songMaxQuotaOf(album)} שירים מתוך האלבום`), ...itemPrompt(prompts, "album", album, "האלבום")];
        const selectedSongs = await chooseMany(call, intro, albumSongs, songMinimum, songMaximum, "לשיר", "song", prompts, `songs-menu:${album.id}`);
        songIdsByAlbum[album.id] = selectedSongs.map((song) => song.id);
        await saveProgress(voterPhone, { albumIds: selectedAlbums.map((a) => a.id), songIdsByAlbum, artistIds: selectedArtists.map((a) => a.id) });
      }
      menuLead = prompt(prompts, "system:section_saved", "בחירת השירים נשמרה חוזרים לתפריט הראשי");
    } else if (answer === "3" && rules.artistsEnabled) {
      selectedArtists = await chooseMany(call, prompt(prompts, "system:artists_intro", `בחרו בין ${artistMinQuota} ל ${artistMaxQuota} זמרים`), catalog.artists || [], artistMinimum, artistMaximum, "לזמר", "artist", prompts, artistMenuKey);
      await saveProgress(voterPhone, { albumIds: selectedAlbums.map((a) => a.id), songIdsByAlbum, artistIds: selectedArtists.map((a) => a.id) });
      menuLead = prompt(prompts, "system:section_saved", "בחירת הזמרים נשמרה חוזרים לתפריט הראשי");
    }
  }

  const submission = await api("/api/ballots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voterKey: voterPhone, albumIds: selectedAlbums.map((item) => item.id), songIdsByAlbum, artistIds: selectedArtists.map((item) => item.id), channel: "phone" }),
  });
  if (submission.response.status === 409) {
    await clearProgress(voterPhone);
    call.id_list_message(prompt(prompts, "system:already_voted", "כבר הצבעתם במצעד ממספר זה תודה"), { prependToNextAction: true });
    return finishCall(call);
  }
  if (submission.response.status === 400) {
    await clearProgress(voterPhone);
    call.id_list_message([text("רשימת הסקר השתנתה בזמן ההצבעה. הבחירות הישנות נוקו. נא לחייג שוב ולבחור מחדש")], { prependToNextAction: true });
    return call.hangup();
  }
  if (!submission.response.ok) return call.id_list_message(prompt(prompts, "system:error", "שמירת ההצבעה נכשלה נא לנסות שוב מאוחר יותר"));
  await clearProgress(voterPhone);
  call.id_list_message(prompt(prompts, "system:success", "תודה הצבעתכם נקלטה בהצלחה"), { prependToNextAction: true });
  return finishCall(call);
});

const app = express();
app.use(router);
app.get("/healthz", (_request, response) => response.send("ok"));
app.listen(PORT, () => console.log(`IVR listening on ${PORT}`));
