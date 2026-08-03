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
    const result = await response.json();
    return { response, result };
  } finally { clearTimeout(timer); }
}

function phone(call) { return call.phone || call.ApiPhone || call.values?.ApiPhone || call.values?.Phone || call.callId || "unknown"; }
function text(data) { return { type: "text", data }; }

async function chooseOne(call, title, items, label) {
  const messages = [text(title)];
  items.forEach((item, index) => messages.push(text(`${label} ${item.title || item.name}, הקישו ${index + 1}. `)));
  const answer = await call.read(messages, "tap", { min_digits: 1, max_digits: String(items.length).length, digits_allowed: items.map((_, index) => index + 1) });
  return items[Number(answer) - 1];
}

async function chooseMany(call, title, items, amount, label) {
  if (!amount) return [];
  if (items.length < amount) throw new Error(`not enough ${label} choices`);
  const remaining = [...items];
  const selected = [];
  while (selected.length < amount) {
    const choice = await chooseOne(call, `${title} בחירה ${selected.length + 1} מתוך ${amount}. `, remaining, label);
    if (!choice) throw new Error("invalid choice");
    selected.push(choice);
    remaining.splice(remaining.findIndex((item) => item.id === choice.id), 1);
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
  if (!response.ok || !catalog.rules?.votingOpen) return call.id_list_message([text("ההצבעה עדיין אינה פתוחה.")]);

  const rules = catalog.rules;
  const albumAmount = rules.albumsEnabled ? rules.albumsMax : 0;
  const songsPerAlbum = rules.songsEnabled ? rules.songsMax : 0;
  const artistAmount = rules.artistsEnabled ? rules.artistsMax : 0;
  if (rules.albumsEnabled && (!catalog.albums?.length || catalog.albums.length < albumAmount)) return call.id_list_message([text("רשימת האלבומים עדיין אינה מוכנה.")]);

  const selectedAlbums = await chooseMany(call, `בחרו ${albumAmount} אלבומים. `, catalog.albums || [], albumAmount, "לאלבום");
  const songIdsByAlbum = {};
  if (rules.songsEnabled) {
    for (const album of selectedAlbums) {
      const albumSongs = (catalog.songs || []).filter((song) => song.albumId === album.id);
      const selectedSongs = await chooseMany(call, `בחרו ${songsPerAlbum} שירים מתוך האלבום ${album.title}. `, albumSongs, songsPerAlbum, "לשיר");
      songIdsByAlbum[album.id] = selectedSongs.map((song) => song.id);
    }
  }

  const selectedArtists = await chooseMany(call, `בחרו ${artistAmount} זמרים. `, catalog.artists || [], artistAmount, "לזמר");
  const submission = await api("/api/ballots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voterKey: phone(call), albumIds: selectedAlbums.map((item) => item.id), songIdsByAlbum, artistIds: selectedArtists.map((item) => item.id), channel: "phone" }),
  });
  if (submission.response.status === 409) return call.id_list_message([text("כבר הצבעתם במצעד ממספר זה. תודה.")]);
  if (!submission.response.ok) return call.id_list_message([text("שמירת ההצבעה נכשלה. נא לנסות שוב מאוחר יותר.")]);
  return call.id_list_message([text("תודה. הצבעתכם נקלטה בהצלחה.")]);
});

const app = express();
app.use(router);
app.get("/healthz", (_request, response) => response.send("ok"));
app.listen(PORT, () => console.log(`IVR listening on ${PORT}`));
