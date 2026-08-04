const express = require("express");
const { YemotRouter } = require("yemot-router2");

const SITE_API_BASE_URL = process.env.SITE_API_BASE_URL;
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = 8000;
if (!SITE_API_BASE_URL) { console.error("חסר SITE_API_BASE_URL"); process.exit(1); }

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${SITE_API_BASE_URL}${path}`, { ...options, signal: controller.signal });
    const raw = await response.text();
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error(`site api returned ${response.status} instead of json`); }
    return { response, result };
  } finally { clearTimeout(timer); }
}

function phone(call) { return call.phone || call.ApiPhone || call.values?.ApiPhone || call.values?.Phone || call.callId || "unknown"; }
function text(data) { return { type: "text", data }; }
function number(data) { return { type: "digits", data: String(data) }; }
function file(data) { return { type: "file", data }; }

function promptMap(catalog) { return new Map((catalog.ivrPrompts || []).filter((item) => item?.key).map((item) => [item.key, item])); }
function prompt(prompts, key, fallback) {
  const item = prompts.get(key);
  return item?.yemotPath ? [file(item.yemotPath)] : [text(fallback)];
}
function itemPrompt(prompts, kind, item, label) {
  const recorded = prompts.get(`${kind}:${item.id}`);
  return recorded?.yemotPath ? [file(recorded.yemotPath)] : [text(`${label} ${item.title || item.name}`)];
}

async function chooseOne(call, messages, items, label, kind, prompts) {
  const full = [...messages];
  items.forEach((item, index) => full.push(...itemPrompt(prompts, kind, item, label), text("הקישו"), number(index + 1)));
  const answer = await call.read(full, "tap", { min_digits: 1, max_digits: String(items.length).length, digits_allowed: items.map((_, index) => index + 1), typing_playback_mode: "No" });
  return items[Number(answer) - 1];
}

async function chooseMany(call, intro, items, amount, label, kind, prompts) {
  if (!amount) return [];
  if (items.length < amount) throw new Error(`not enough ${label} choices`);
  const selected = [];
  const selectedIds = new Set();
  let lead = [];
  let showIntro = true;
  while (selected.length < amount) {
    const messages = [...lead, ...(showIntro ? intro : []), text(`בחירה ${selected.length + 1} מתוך ${amount}`)];
    lead = [];
    showIntro = false;
    const choice = await chooseOne(call, messages, items, label, kind, prompts);
    if (!choice) throw new Error("invalid choice");
    if (selectedIds.has(choice.id)) {
      lead = prompt(prompts, "system:already_selected", "כבר הצבעתם לזה בחרו אפשרות אחרת");
      continue;
    }
    selected.push(choice);
    selectedIds.add(choice.id);
  }
  return selected;
}

const router = YemotRouter({
  printLog: true,
  defaults: { removeInvalidChars: true, read: { removeInvalidChars: true }, id_list_message: { removeInvalidChars: true } },
  uncaughtErrorHandler: async (error, call) => {
    console.error("IVR error", error);
    try { call.id_list_message([text("אירעה שגיאה במערכת. נא לנסות שוב מאוחר יותר.")]); } catch {}
  },
});

router.get("/", async (call) => {
  const { response, result: catalog } = await api("/api/catalog");
  const prompts = promptMap(catalog);
  if (!response.ok || !catalog.rules?.votingOpen) return call.id_list_message(prompt(prompts, "system:voting_closed", "ההצבעה עדיין אינה פתוחה"));

  const voterPhone = phone(call);
  try {
    const { result: check } = await api(`/api/ballots/check?voterKey=${encodeURIComponent(voterPhone)}`);
    if (check.voted) return call.id_list_message(prompt(prompts, "system:already_voted", "כבר הצבעתם במצעד ממספר זה תודה"));
  } catch {}


  const rules = catalog.rules;
  const albumAmount = rules.albumsEnabled ? rules.albumsMax : 0;
  const songsPerAlbum = rules.songsEnabled ? rules.songsMax : 0;
  const artistAmount = rules.artistsEnabled ? rules.artistsMax : 0;
  if (rules.albumsEnabled && (!catalog.albums?.length || catalog.albums.length < albumAmount)) return call.id_list_message(prompt(prompts, "system:not_ready", "רשימת האלבומים עדיין אינה מוכנה"));

  let selectedAlbums = [], selectedArtists = [], songIdsByAlbum = {}, menuLead = [];
  const complete = () => (!rules.albumsEnabled || selectedAlbums.length === albumAmount) && (!rules.songsEnabled || selectedAlbums.every((album) => (songIdsByAlbum[album.id] || []).length === songsPerAlbum)) && (!rules.artistsEnabled || selectedArtists.length === artistAmount);
  while (!complete()) {
    const allowed = [rules.albumsEnabled && 1, rules.songsEnabled && 2, rules.artistsEnabled && 3].filter(Boolean);
    const fallback = "לבחירת אלבומים הקישו 1 לבחירת שירים מתוך האלבומים שבחרתם הקישו 2 לבחירת זמרים הקישו 3";
    const answer = await call.read([...menuLead, ...prompt(prompts, "system:main_menu", fallback)], "tap", { min_digits: 1, max_digits: 1, digits_allowed: allowed, typing_playback_mode: "No" });
    menuLead = [];
    if (answer === "1" && rules.albumsEnabled) {
      selectedAlbums = await chooseMany(call, prompt(prompts, "system:albums_intro", `בחרו ${albumAmount} אלבומים`), catalog.albums || [], albumAmount, "לאלבום", "album", prompts);
      songIdsByAlbum = {};
      menuLead = prompt(prompts, "system:section_saved", "בחירת האלבומים נשמרה חוזרים לתפריט הראשי");
    } else if (answer === "2" && rules.songsEnabled) {
      if (!selectedAlbums.length) { menuLead = prompt(prompts, "system:need_albums", "כדי לבחור שירים יש לבחור קודם אלבומים בשלוחה 1"); continue; }
      for (const album of selectedAlbums) {
        const albumSongs = (catalog.songs || []).filter((song) => song.albumId === album.id);
        const intro = [...prompt(prompts, "system:songs_intro", `בחרו ${songsPerAlbum} שירים מתוך האלבום`), ...itemPrompt(prompts, "album", album, "האלבום")];
        const selectedSongs = await chooseMany(call, intro, albumSongs, songsPerAlbum, "לשיר", "song", prompts);
        songIdsByAlbum[album.id] = selectedSongs.map((song) => song.id);
      }
      menuLead = prompt(prompts, "system:section_saved", "בחירת השירים נשמרה חוזרים לתפריט הראשי");
    } else if (answer === "3" && rules.artistsEnabled) {
      selectedArtists = await chooseMany(call, prompt(prompts, "system:artists_intro", `בחרו ${artistAmount} זמרים`), catalog.artists || [], artistAmount, "לזמר", "artist", prompts);
      menuLead = prompt(prompts, "system:section_saved", "בחירת הזמרים נשמרה חוזרים לתפריט הראשי");
    }
  }

  const submission = await api("/api/ballots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voterKey: phone(call), albumIds: selectedAlbums.map((item) => item.id), songIdsByAlbum, artistIds: selectedArtists.map((item) => item.id), channel: "phone" }),
  });
  if (submission.response.status === 409) return call.id_list_message(prompt(prompts, "system:already_voted", "כבר הצבעתם במצעד ממספר זה תודה"));
  if (!submission.response.ok) return call.id_list_message(prompt(prompts, "system:error", "שמירת ההצבעה נכשלה נא לנסות שוב מאוחר יותר"));
  return call.id_list_message(prompt(prompts, "system:success", "תודה הצבעתכם נקלטה בהצלחה"));
});

const app = express();
app.use(router);
app.get("/healthz", (_request, response) => response.send("ok"));
app.listen(PORT, () => console.log(`IVR listening on ${PORT}`));
