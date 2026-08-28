const express = require("express");
const { createHash } = require("crypto");
const { YemotRouter } = require("yemot-router2");
const { phone } = require("./phone");
const { continuousMenuInput, menuCode, menuCodeWidth, menuPages, menuReadOptions } = require("./menu-input");
const RECORDABLE_SYSTEM_PROMPTS = require("./ivr-system-prompts.json");

const SITE_API_BASE_URL = process.env.SITE_API_BASE_URL;
const IVR_SECRET = process.env.IVR_SECRET;
const RECORDINGS_YEMOT_TOKEN = String(process.env.RECORDINGS_YEMOT_TOKEN || "").trim();
const RECORDINGS_YEMOT_API_BASE = String(process.env.RECORDINGS_YEMOT_API_BASE || "https://www.call2all.co.il/ym/api").replace(/\/$/, "");
const RECORDINGS_FOLDER = String(process.env.RECORDINGS_FOLDER || "").trim().replace(/\/$/, "");
const PORT = process.env.PORT || 3000;
const POST_VOTE_TRANSFER = String(process.env.POST_VOTE_TRANSFER || "0796077075").replace(/\D/g, "");
const REQUEST_TIMEOUT_MS = 8000;
if (!SITE_API_BASE_URL) { console.error("חסר SITE_API_BASE_URL"); process.exit(1); }
if (!IVR_SECRET) { console.error("חסר IVR_SECRET"); process.exit(1); }

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

async function api(path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
      if (attempt < MAX_RETRIES) { console.error(`IVR api retry ${attempt + 1} for ${path}:`, error.message); continue; }
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

function text(data) { return { type: "text", data }; }
function number(data) { return { type: "digits", data: String(data) }; }
function file(data) { return { type: "file", data }; }

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

  const pages = menuPages(choices);
  let pageIndex = 0;
  while (true) {
    const page = pages[pageIndex];
    const messages = [text(pageIndex === 0 ? intro : `המשך הרשימה עמוד ${pageIndex + 1} מתוך ${pages.length}`)];
    page.forEach((item, index) => messages.push(text(item.label), text("הקישו"), number(index + 1)));
    messages.push(text(pageIndex === pages.length - 1 ? "לחזרה לתחילת הרשימה הקישו 9" : "להמשך הקישו 9"));
    if (back) messages.push(text(back.label), text("הקישו 0"));
    const digits = page.map((_, index) => index + 1);
    digits.push(9);
    if (back) digits.push(0);
    const answer = await call.read(messages, "tap", menuReadOptions(digits));
    if (answer === "0" && back) return back;
    if (answer === "9") {
      pageIndex = (pageIndex + 1) % pages.length;
      continue;
    }
    return page[Number(answer) - 1] || null;
  }
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

async function recordPromptByPhone(call, key, label) {
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

router.get("/recordings", async (call) => {
  if (!RECORDINGS_YEMOT_TOKEN || !/^\/(?:\d+\/)*\d+$/.test(RECORDINGS_FOLDER)) {
    return call.id_list_message([text("קו ההקלטות עדיין אינו מוגדר")]);
  }

  const callerPhone = phone(call);
  const access = await api(`/api/ivr/recorders/check?phone=${encodeURIComponent(callerPhone)}`);
  if (!access.response.ok || !access.result?.allowed) {
    call.id_list_message([text("מספר הטלפון שלכם אינו מורשה להקליט קריינויות")], { prependToNextAction: true });
    return call.hangup();
  }

  let lead = [text("ברוכים הבאים לקו הקלטת הקריינויות")];
  while (true) {
    const menuIntro = [...lead.map((message) => message.data), "בחרו את סוג הקריינות"].join(" ");
    const section = await adminChoice(call, menuIntro, [
      { digit: 1, label: "להודעות המערכת" },
      { digit: 2, label: "לתפריט האלבומים המלא" },
      { digit: 3, label: "לקריינויות השירים לפי אלבום" },
      { digit: 4, label: "לשמות הזמרים" },
      { digit: 9, label: "לסיום" },
    ]);
    lead = [];
    if (!section || section.digit === 9) {
      call.id_list_message([text("להתראות")], { prependToNextAction: true });
      return call.hangup();
    }

    try {
      const { response, result: catalog } = await api("/api/catalog");
      if (!response.ok || !catalog?.surveyId) throw new Error("catalog unavailable");

      let target = null;
      if (section.digit === 1) {
        target = await adminChoice(call, "בחרו הודעת מערכת להקלטה", [
          ...RECORDABLE_SYSTEM_PROMPTS.map((item, index) => ({ ...item, digit: index + 1 })),
          { digit: 0, key: "", label: "לחזרה לתפריט הראשי" },
        ]);
      } else if (section.digit === 2) {
        const albumMode = await adminChoice(call, "בחרו סוג הקלטה לאלבומים", [
          { digit: 1, key: `albums-menu:${catalog.surveyId}`, label: "להקלטת כל רשימת האלבומים ומספרי ההקשה ברצף" },
          { digit: 2, key: "", label: "להקלטת אלבום בודד" },
          { digit: 0, key: "", label: "לחזרה לתפריט הראשי" },
        ]);
        if (albumMode?.digit === 1) {
          target = await menuRecordingTarget(call, albumMode.key, "רשימת האלבומים ומספרי ההקשה", catalog.albums || []);
        } else if (albumMode?.digit === 2) {
          const album = await adminChoice(call, "בחרו אלבום", [
            ...(catalog.albums || []).map((item, index) => ({ ...item, digit: index + 1, label: `${item.title} מאת ${item.artistName}` })),
            { digit: 0, id: "", label: "לחזרה לתפריט הראשי" },
          ]);
          if (album?.id) target = { key: `album:${album.id}`, label: `שם האלבום ${album.title}` };
        }
      } else if (section.digit === 3) {
        const album = await adminChoice(call, "בחרו אלבום", [
          ...(catalog.albums || []).map((item, index) => ({ ...item, digit: index + 1, label: `${item.title} מאת ${item.artistName}` })),
          { digit: 0, id: "", label: "לחזרה לתפריט הראשי" },
        ]);
        if (album?.id) {
          const songTarget = await adminChoice(call, `בחרו קריינות עבור האלבום ${album.title}`, [
            { digit: 1, key: `album-name:${album.id}`, label: "הקלטת שם האלבום" },
            { digit: 2, key: `songs-menu:${album.id}`, label: "הקלטת כל השירים ומספרי ההקשה ברצף" },
            { digit: 3, key: "", label: "הקלטת שיר בודד" },
            { digit: 0, key: "", label: "לחזרה לתפריט הראשי" },
          ]);
          if (songTarget?.digit === 2) {
            const songs = (catalog.songs || []).filter((song) => song.albumId === album.id);
            target = await menuRecordingTarget(call, songTarget.key, `רשימת השירים ומספרי ההקשה של ${album.title}`, songs);
          } else if (songTarget?.key) {
            target = { key: songTarget.key, label: `${songTarget.label} של ${album.title}` };
          } else if (songTarget?.digit === 3) {
            const songs = (catalog.songs || []).filter((song) => song.albumId === album.id);
            const song = await adminChoice(call, "בחרו שיר", [
              ...songs.map((item, index) => ({ ...item, digit: index + 1, label: item.title })),
              { digit: 0, id: "", label: "לחזרה לתפריט הראשי" },
            ]);
            if (song?.id) target = { key: `song:${song.id}`, label: `שם השיר ${song.title}` };
          }
        }
      } else if (section.digit === 4) {
        const artistMode = await adminChoice(call, "בחרו סוג הקלטה לזמרים", [
          { digit: 1, key: `artists-menu:${catalog.surveyId}`, label: "להקלטת כל רשימת הזמרים ומספרי ההקשה ברצף" },
          { digit: 2, key: "", label: "להקלטת זמר בודד" },
          { digit: 0, key: "", label: "לחזרה לתפריט הראשי" },
        ]);
        if (artistMode?.digit === 1) {
          target = await menuRecordingTarget(call, artistMode.key, "רשימת הזמרים ומספרי ההקשה", catalog.artists || []);
        } else if (artistMode?.digit === 2) {
          const artist = await adminChoice(call, "בחרו זמר", [
            ...(catalog.artists || []).map((item, index) => ({ ...item, digit: index + 1, label: item.name })),
            { digit: 0, id: "", label: "לחזרה לתפריט הראשי" },
          ]);
          if (artist?.id) target = { key: `artist:${artist.id}`, label: `שם הזמר ${artist.name}` };
        }
      }

      if (!target?.key) {
        lead = [text("חזרתם לתפריט הראשי")];
        continue;
      }
      await recordPromptByPhone(call, target.key, target.label);
      lead = [text("הקריינות נשמרה והיא פעילה בקו ההצבעה")];
    } catch (error) {
      console.error("recordings IVR error", error);
      lead = [text("שמירת הקריינות נכשלה נא לנסות שוב")];
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
      return call.routing_yemot(POST_VOTE_TRANSFER);
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
    if (saved.albumIds?.length) selectedAlbums = (catalog.albums || []).filter((a) => saved.albumIds.includes(a.id));
    if (saved.songIdsByAlbum) songIdsByAlbum = saved.songIdsByAlbum;
    if (saved.artistIds?.length) selectedArtists = (catalog.artists || []).filter((a) => saved.artistIds.includes(a.id));
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
    return call.routing_yemot(POST_VOTE_TRANSFER);
  }
  if (!submission.response.ok) return call.id_list_message(prompt(prompts, "system:error", "שמירת ההצבעה נכשלה נא לנסות שוב מאוחר יותר"));
  await clearProgress(voterPhone);
  call.id_list_message(prompt(prompts, "system:success", "תודה הצבעתכם נקלטה בהצלחה"), { prependToNextAction: true });
  return call.routing_yemot(POST_VOTE_TRANSFER);
});

const app = express();
app.use(router);
app.get("/healthz", (_request, response) => response.send("ok"));
app.listen(PORT, () => console.log(`IVR listening on ${PORT}`));
