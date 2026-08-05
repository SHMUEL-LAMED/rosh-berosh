import { readAdminEmails, readSession, saveAdminEmails } from "./auth";
import { ensureRuntimeSchema } from "./schema";
import { readIvrPrompts, saveIvrPrompts, syncPromptToYemot } from "./ivr-prompts";

type AdminEnv = { DB: D1Database; MEDIA: R2Bucket; YEMOT_TOKEN?: string; YEMOT_API_BASE?: string; AI_API_KEY?: string; AI_BASE_URL?: string; AI_TRANSCRIBE_MODEL?: string; AI_CHAT_MODEL?: string; TTS_PROVIDER?: string; ELEVENLABS_API_KEY?: string; ELEVENLABS_VOICE_ID?: string; GOOGLE_SA_KEY?: string };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const ARCHIVE_PREFIX = "poll-archives/";

type PollSnapshot = {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  albums: Record<string, unknown>[];
  songs: Record<string, unknown>[];
  artists: Record<string, unknown>[];
  ballots: Record<string, unknown>[];
  albumVotes: Record<string, unknown>[];
  songVotes: Record<string, unknown>[];
  artistVotes: Record<string, unknown>[];
  settings: Record<string, unknown> | null;
};

async function requireAdmin(request: Request, env: AdminEnv) {
  const user = await readSession(request, env);
  return user?.isAdmin ? user : null;
}

async function activeSurveyId(env: AdminEnv): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM surveys WHERE active = 1 ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
  if (row?.id) return row.id;
  // No active survey (fresh install upgraded mid-flight): fall back to 'main' and make sure a row exists.
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO surveys (id,name,active) VALUES ('main','הסקר הראשי',1)"),
    env.DB.prepare("INSERT OR IGNORE INTO poll_settings (id) VALUES ('main')"),
  ]);
  return "main";
}

const text = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const flag = (value: unknown) => value === true || value === 1 || value === "1" || value === "true" || value === "on";
const DEFAULT_SETTINGS = { votingOpen: 0, albumsEnabled: 1, albumsMin: 5, albumsMax: 5, songsEnabled: 1, songsMin: 1, songsMax: 1, artistsEnabled: 1, artistsMin: 1, artistsMax: 3 };
const mediaUrl = (key: string) => `/media/${key.split("/").map(encodeURIComponent).join("/")}`;
const safeName = (name: string) => name.normalize("NFKD").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 110) || "file";
const keyFromMediaUrl = (url?: string | null) => url?.startsWith("/media/") ? decodeURIComponent(url.slice(7)) : null;

function extractCoverFromAudio(buffer: ArrayBuffer): { data: Uint8Array; mime: string } | null {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null; // not ID3v2
  const version = bytes[3];
  const tagSize = (bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f);
  const headerSize = version >= 4 && (bytes[5] & 0x40) ? 20 : 10;
  let pos = headerSize;
  const end = Math.min(10 + tagSize, bytes.length);
  while (pos + 10 < end) {
    const frameId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    if (frameId[0] === "\0") break;
    let frameSize: number;
    if (version >= 4) {
      frameSize = (bytes[pos + 4] & 0x7f) << 21 | (bytes[pos + 5] & 0x7f) << 14 | (bytes[pos + 6] & 0x7f) << 7 | (bytes[pos + 7] & 0x7f);
    } else {
      frameSize = bytes[pos + 4] << 24 | bytes[pos + 5] << 16 | bytes[pos + 6] << 8 | bytes[pos + 7];
    }
    if (frameSize <= 0 || pos + 10 + frameSize > end) break;
    if (frameId === "APIC") {
      let offset = pos + 10;
      const encoding = bytes[offset++];
      let mime = "";
      while (offset < pos + 10 + frameSize && bytes[offset] !== 0) mime += String.fromCharCode(bytes[offset++]);
      offset++; // null terminator
      offset++; // picture type
      if (encoding === 0 || encoding === 3) { while (offset < pos + 10 + frameSize && bytes[offset] !== 0) offset++; offset++; }
      else if (encoding === 1 || encoding === 2) { while (offset + 1 < pos + 10 + frameSize && !(bytes[offset] === 0 && bytes[offset + 1] === 0)) offset += 2; offset += 2; }
      const data = bytes.slice(offset, pos + 10 + frameSize);
      if (data.length > 100) return { data, mime: mime || "image/jpeg" };
    }
    pos += 10 + frameSize;
  }
  return null;
}

async function deleteMediaUrls(env: AdminEnv, urls: Array<string | null | undefined>) {
  const keys = [...new Set(urls.map(keyFromMediaUrl).filter((key): key is string => !!key))];
  if (keys.length) {
    const results = await Promise.allSettled(keys.map((key) => env.MEDIA.delete(key)));
    results.forEach((result, index) => { if (result.status === "rejected") console.error("media cleanup failed", keys[index], result.reason); });
  }
}

async function readPollSnapshot(env: AdminEnv, key: string) {
  if (!key.startsWith(ARCHIVE_PREFIX) || !key.endsWith(".json")) throw new Error("invalid archive key");
  const object = await env.MEDIA.get(key);
  if (!object) return null;
  return JSON.parse(await object.text()) as PollSnapshot;
}

async function createPollSnapshot(env: AdminEnv, requestedName = "", surveyId?: string) {
  const survey = surveyId ?? await activeSurveyId(env);
  const [albums, songs, artists, ballots, albumVotes, songVotes, artistVotes, settings] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM albums WHERE survey_id=? ORDER BY position,title").bind(survey),
    env.DB.prepare("SELECT s.* FROM songs s JOIN albums a ON a.id=s.album_id WHERE a.survey_id=? ORDER BY s.album_id,s.position,s.title").bind(survey),
    env.DB.prepare("SELECT * FROM artists WHERE survey_id=? ORDER BY position,name").bind(survey),
    env.DB.prepare("SELECT * FROM ballots WHERE survey_id=? ORDER BY created_at").bind(survey),
    env.DB.prepare("SELECT v.* FROM album_votes v JOIN ballots b ON b.id=v.ballot_id WHERE b.survey_id=?").bind(survey),
    env.DB.prepare("SELECT v.* FROM song_votes v JOIN ballots b ON b.id=v.ballot_id WHERE b.survey_id=?").bind(survey),
    env.DB.prepare("SELECT v.* FROM artist_votes v JOIN ballots b ON b.id=v.ballot_id WHERE b.survey_id=?").bind(survey),
    env.DB.prepare("SELECT * FROM poll_settings WHERE id=?").bind(survey),
  ]);
  const createdAt = Date.now(), id = crypto.randomUUID();
  const name = requestedName.trim() || `סקר ${new Date(createdAt).toLocaleDateString("he-IL")}`;
  const snapshot: PollSnapshot = { version: 1, id, name, createdAt, albums: albums.results, songs: songs.results, artists: artists.results, ballots: ballots.results, albumVotes: albumVotes.results, songVotes: songVotes.results, artistVotes: artistVotes.results, settings: settings.results[0] || null };
  const key = `${ARCHIVE_PREFIX}${createdAt}-${id}.json`;
  await env.MEDIA.put(key, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" }, customMetadata: { name, createdAt: String(createdAt), votes: String(ballots.results.length) } });
  return { key, name, createdAt, votes: ballots.results.length, albums: albums.results.length, songs: songs.results.length, artists: artists.results.length, snapshot };
}

async function clearCurrentPoll(env: AdminEnv, surveyId?: string) {
  const survey = surveyId ?? await activeSurveyId(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM song_votes WHERE ballot_id IN (SELECT id FROM ballots WHERE survey_id=?)").bind(survey),
    env.DB.prepare("DELETE FROM album_votes WHERE ballot_id IN (SELECT id FROM ballots WHERE survey_id=?)").bind(survey),
    env.DB.prepare("DELETE FROM artist_votes WHERE ballot_id IN (SELECT id FROM ballots WHERE survey_id=?)").bind(survey),
    env.DB.prepare("DELETE FROM ballots WHERE survey_id=?").bind(survey),
    env.DB.prepare("DELETE FROM songs WHERE album_id IN (SELECT id FROM albums WHERE survey_id=?)").bind(survey),
    env.DB.prepare("DELETE FROM albums WHERE survey_id=?").bind(survey),
    env.DB.prepare("DELETE FROM artists WHERE survey_id=?").bind(survey),
    env.DB.prepare("UPDATE poll_settings SET voting_open=0, albums_enabled=1, albums_min=5, albums_max=5, songs_enabled=1, songs_min=1, songs_max=1, artists_enabled=1, artists_min=1, artists_max=3 WHERE id=?").bind(survey),
  ]);
}

async function pollReadiness(env: AdminEnv, surveyId?: string) {
  const survey = surveyId ?? await activeSurveyId(env);
  const [albums, songs, artists, settingsResult] = await env.DB.batch([
    env.DB.prepare("SELECT id,title,cover_url AS coverUrl FROM albums WHERE active=1 AND survey_id=?").bind(survey),
    env.DB.prepare("SELECT s.album_id AS albumId,COUNT(*) AS total,SUM(CASE WHEN s.audio_url IS NOT NULL AND s.audio_url<>'' THEN 1 ELSE 0 END) AS withAudio FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.active=1 AND a.survey_id=? GROUP BY s.album_id").bind(survey),
    env.DB.prepare("SELECT COUNT(*) AS total FROM artists WHERE active=1 AND survey_id=?").bind(survey),
    env.DB.prepare("SELECT * FROM poll_settings WHERE id=?").bind(survey),
  ]);
  const settings = settingsResult.results[0] || {};
  const songMap = new Map(songs.results.map((row) => [String(row.albumId), Number(row.total || 0)]));
  const requiredSongs = Number(settings.songs_enabled) ? Number(settings.songs_max || 1) : 0;
  const missingSongs = albums.results.filter((album) => (songMap.get(String(album.id)) || 0) < requiredSongs).map((album) => String(album.title));
  const artistCount = Number(artists.results[0]?.total || 0);
  const warnings: string[] = [];
  if (Number(settings.albums_enabled) && albums.results.length < Number(settings.albums_max || 1)) warnings.push(`צריך לפחות ${settings.albums_max} אלבומים פעילים`);
  if (Number(settings.songs_enabled) && missingSongs.length) warnings.push(`${missingSongs.length} אלבומים בלי מספיק שירים לבחירה`);
  if (Number(settings.artists_enabled) && artistCount < Number(settings.artists_max || 1)) warnings.push(`צריך לפחות ${settings.artists_max} זמרים פעילים`);
  return { ready: warnings.length === 0, warnings, counts: { albums: albums.results.length, songs: songs.results.reduce((sum, row) => sum + Number(row.total || 0), 0), artists: artistCount, missingCovers: albums.results.filter((album) => !album.coverUrl).length, missingSongs: missingSongs.length } };
}

const AI_MAX_BYTES = 25 * 1024 * 1024; // external transcription APIs cap uploads at 25MB

// Detects the chorus of a song with an external, OpenAI-compatible AI service:
// transcribe the audio with segment timestamps, then let a language model pick the
// repeated hook and return a short excerpt. Throws on any failure so callers can fall back.
async function suggestChorusAI(env: AdminEnv, audioUrl: string): Promise<{ start: number; end: number }> {
  const key = env.AI_API_KEY;
  if (!key) throw new Error("שירות ה-AI אינו מוגדר (חסר AI_API_KEY).");
  const mediaKey = keyFromMediaUrl(audioUrl);
  if (!mediaKey) throw new Error("לשיר אין קובץ שמע מקומי לניתוח.");
  const object = await env.MEDIA.get(mediaKey);
  if (!object) throw new Error("קובץ השמע לא נמצא.");
  if (object.size > AI_MAX_BYTES) throw new Error("קובץ השמע גדול מ־25MB ולכן אי אפשר לנתחו ב-AI.");

  const base = (env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const transcribeModel = env.AI_TRANSCRIBE_MODEL || "whisper-1";
  const chatModel = env.AI_CHAT_MODEL || "gpt-4o-mini";
  const contentType = object.httpMetadata?.contentType || "audio/mpeg";

  // 1) Transcribe with per-segment timestamps.
  const form = new FormData();
  form.append("file", new File([await object.arrayBuffer()], "audio", { type: contentType }));
  form.append("model", transcribeModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const transcription = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  if (!transcription.ok) throw new Error(`התמלול נכשל (שגיאה ${transcription.status}).`);
  const transcript = (await transcription.json()) as { duration?: number; segments?: { start: number; end: number; text: string }[] };
  const segments = (transcript.segments || []).map((s) => ({ start: Math.round(s.start), end: Math.round(s.end), text: String(s.text || "").trim() })).filter((s) => s.text);
  const duration = Number(transcript.duration || (segments.length ? segments[segments.length - 1].end : 0));
  if (!segments.length || !duration) throw new Error("לא התקבל תמלול עם חותמות זמן.");

  // 2) Let the language model locate the chorus (the repeated hook).
  const chat = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: chatModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are given a song's transcript as timestamped segments (in seconds). Identify the chorus — the most repeated, catchy hook — and return a 25-30 second excerpt that begins exactly where the chorus starts. Respond ONLY as JSON: {\"start\": number, \"end\": number} in seconds." },
        { role: "user", content: JSON.stringify({ duration, segments }) },
      ],
    }),
  });
  if (!chat.ok) throw new Error(`ניתוח הפזמון נכשל (שגיאה ${chat.status}).`);
  const completion = (await chat.json()) as { choices?: { message?: { content?: string } }[] };
  let parsed: { start?: number; end?: number };
  try { parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}"); } catch { throw new Error("תשובת ה-AI לא הייתה בפורמט תקין."); }

  const start = Math.max(0, Math.round(Number(parsed.start) || 0));
  let end = Math.round(Number(parsed.end) || 0);
  if (!(end > start)) end = start + 28;
  if (end - start > 45) end = start + 30; // keep the excerpt reasonable
  end = Math.min(end, Math.floor(duration));
  if (!(end > start)) throw new Error("ה-AI לא החזיר טווח זמן תקין.");
  return { start, end };
}

type SurveyRow = { id: string; name: string; active: number; createdAt: number; votingOpen: number; albums: number; songs: number; artists: number; votes: number };

async function listSurveys(env: AdminEnv): Promise<{ surveys: SurveyRow[] }> {
  const result = await env.DB.prepare(
    `SELECT s.id, s.name, s.active, s.created_at AS createdAt, COALESCE(p.voting_open,0) AS votingOpen,
       (SELECT COUNT(*) FROM albums a WHERE a.survey_id=s.id) AS albums,
       (SELECT COUNT(*) FROM songs so JOIN albums a ON a.id=so.album_id WHERE a.survey_id=s.id) AS songs,
       (SELECT COUNT(*) FROM artists ar WHERE ar.survey_id=s.id) AS artists,
       (SELECT COUNT(*) FROM ballots b WHERE b.survey_id=s.id) AS votes
     FROM surveys s LEFT JOIN poll_settings p ON p.id=s.id
     ORDER BY s.active DESC, s.created_at DESC`,
  ).all<SurveyRow>();
  return { surveys: result.results };
}

function toBase64Url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function strToBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function googleAccessToken(saKeyJson: string): Promise<string> {
  const sa = JSON.parse(saKeyJson) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const header = strToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = strToBase64Url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  const jwt = `${header}.${payload}.${toBase64Url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!response.ok) throw new Error(`אימות Google נכשל (שגיאה ${response.status}).`);
  const token = await response.json<{ access_token: string }>();
  return token.access_token;
}

function ttsConfigured(env: AdminEnv): boolean {
  if (env.TTS_PROVIDER === "google") return Boolean(env.GOOGLE_SA_KEY);
  if (env.TTS_PROVIDER === "elevenlabs") return Boolean(env.ELEVENLABS_API_KEY);
  return Boolean(env.AI_API_KEY);
}

async function generateTtsAudio(env: AdminEnv, inputText: string): Promise<ArrayBuffer> {
  if (env.TTS_PROVIDER === "google") {
    if (!env.GOOGLE_SA_KEY) throw new Error("שירות ה-TTS אינו מוגדר (חסר GOOGLE_SA_KEY).");
    const accessToken = await googleAccessToken(env.GOOGLE_SA_KEY);
    const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        input: { text: inputText },
        voice: { languageCode: "he-IL", name: "he-IL-Standard-B" },
        audioConfig: { audioEncoding: "MP3", sampleRateHertz: 44100 },
      }),
    });
    if (!response.ok) {
      const status = response.status;
      if (status === 403) throw new Error("ל-Service Account אין הרשאה ל-Text-to-Speech API. בדקו שה-API מופעל בפרויקט.");
      throw new Error(`יצירת הקריינות נכשלה ב-Google Cloud (שגיאה ${status}).`);
    }
    const result = await response.json<{ audioContent: string }>();
    const binary = atob(result.audioContent);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  if (env.TTS_PROVIDER === "elevenlabs") {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("שירות ה-TTS אינו מוגדר (חסר ELEVENLABS_API_KEY).");
    const voiceId = env.ELEVENLABS_VOICE_ID;
    if (!voiceId) throw new Error("חסר ELEVENLABS_VOICE_ID. הגדירו מזהה קול בסביבת Cloudflare.");
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: inputText, model_id: "eleven_v3", language_code: "he", output_format: "mp3_44100_128" }),
    });
    if (!response.ok) {
      const status = response.status;
      if (status === 401) throw new Error("מפתח ElevenLabs אינו תקין. בדקו את ELEVENLABS_API_KEY.");
      if (status === 429) throw new Error("חריגה ממכסת הבקשות ב-ElevenLabs. נסו שוב בעוד מספר שניות.");
      throw new Error(`יצירת הקריינות נכשלה ב-ElevenLabs (שגיאה ${status}).`);
    }
    return response.arrayBuffer();
  }
  // Fallback: OpenAI-compatible API
  if (!env.AI_API_KEY) throw new Error("שירות ה-TTS אינו מוגדר (חסר AI_API_KEY).");
  const base = (env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.AI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "tts-1", input: inputText, voice: "alloy", response_format: "mp3" }),
  });
  if (!response.ok) {
    const status = response.status;
    if (status === 429) throw new Error("חריגה ממכסת הבקשות. נסו שוב בעוד מספר שניות.");
    throw new Error(`יצירת הקריינות נכשלה (שגיאה ${status}).`);
  }
  return response.arrayBuffer();
}

export async function adminApi(request: Request, env: AdminEnv): Promise<Response> {
  const currentAdmin = await requireAdmin(request, env);
  if (!currentAdmin) return json({ error: "אין הרשאת מנהל." }, 403);
  await ensureRuntimeSchema(env);
  const url = new URL(request.url);
  const surveyId = await activeSurveyId(env);

  if (request.method === "GET" && url.pathname === "/api/admin/surveys") {
    return json(await listSurveys(env));
  }

  if (request.method === "POST" && url.pathname === "/api/admin/surveys/activate") {
    const body = await request.json<{ id?: string }>();
    const id = text(body.id);
    const survey = id ? await env.DB.prepare("SELECT id FROM surveys WHERE id=?").bind(id).first<{ id: string }>() : null;
    if (!survey) return json({ error: "הסקר לא נמצא." }, 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE surveys SET active=0"),
      env.DB.prepare("UPDATE surveys SET active=1 WHERE id=?").bind(id),
    ]);
    return json({ ok: true, surveys: await listSurveys(env) });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/surveys") {
    const body = await request.json<{ id?: string; name?: string }>();
    const name = text(body.name);
    if (!name) return json({ error: "יש להזין שם לסקר." }, 400);
    if (body.id) {
      const existing = await env.DB.prepare("SELECT id FROM surveys WHERE id=?").bind(text(body.id)).first();
      if (!existing) return json({ error: "הסקר לא נמצא." }, 404);
      await env.DB.prepare("UPDATE surveys SET name=? WHERE id=?").bind(name, text(body.id)).run();
      return json({ ok: true, surveys: await listSurveys(env) });
    }
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO surveys (id,name,active) VALUES (?,?,0)").bind(id, name),
      env.DB.prepare("INSERT INTO poll_settings (id,voting_open) VALUES (?,0)").bind(id),
    ]);
    return json({ ok: true, id, surveys: await listSurveys(env) });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/surveys") {
    const body = await request.json<{ id?: string }>();
    const id = text(body.id);
    if (!id) return json({ error: "מזהה הסקר חסר." }, 400);
    const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM surveys").first<{ total: number }>();
    if (Number(total?.total || 0) <= 1) return json({ error: "אי אפשר למחוק את הסקר האחרון." }, 400);
    const target = await env.DB.prepare("SELECT active FROM surveys WHERE id=?").bind(id).first<{ active: number }>();
    if (!target) return json({ error: "הסקר לא נמצא." }, 404);
    if (Number(target.active)) return json({ error: "אי אפשר למחוק סקר פעיל. הפעילו קודם סקר אחר." }, 400);
    const media = await env.DB.batch([
      env.DB.prepare("SELECT cover_url AS url FROM albums WHERE survey_id=?").bind(id),
      env.DB.prepare("SELECT s.audio_url AS url FROM songs s JOIN albums a ON a.id=s.album_id WHERE a.survey_id=?").bind(id),
    ]);
    await clearCurrentPoll(env, id);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM poll_settings WHERE id=?").bind(id),
      env.DB.prepare("DELETE FROM surveys WHERE id=?").bind(id),
    ]);
    await deleteMediaUrls(env, [...media[0].results, ...media[1].results].map((row) => (row as { url?: string }).url));
    return json({ ok: true, surveys: await listSurveys(env) });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/overview") {
    const [albums, songs, artists, ballots, settings, albumResults, songResults, artistResults] = await env.DB.batch([
      env.DB.prepare("SELECT id, title, artist_name AS artistName, cover_url AS coverUrl, position, active FROM albums WHERE survey_id=? ORDER BY position, title").bind(surveyId),
      env.DB.prepare("SELECT s.id, s.album_id AS albumId, s.title, s.audio_url AS audioUrl, s.cover_url AS coverUrl, s.preview_start AS previewStart, s.preview_end AS previewEnd, s.position, s.active FROM songs s JOIN albums a ON a.id=s.album_id WHERE a.survey_id=? ORDER BY s.album_id, s.position, s.title").bind(surveyId),
      env.DB.prepare("SELECT id, name, image_url AS imageUrl, position, active FROM artists WHERE survey_id=? ORDER BY position, name").bind(surveyId),
      env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN channel = 'phone' THEN 1 ELSE 0 END) AS phone, SUM(CASE WHEN channel = 'site' THEN 1 ELSE 0 END) AS site FROM ballots WHERE survey_id=?").bind(surveyId),
      env.DB.prepare("SELECT voting_open AS votingOpen, albums_enabled AS albumsEnabled, albums_min AS albumsMin, albums_max AS albumsMax, songs_enabled AS songsEnabled, songs_min AS songsMin, songs_max AS songsMax, artists_enabled AS artistsEnabled, artists_min AS artistsMin, artists_max AS artistsMax FROM poll_settings WHERE id = ?").bind(surveyId),
      env.DB.prepare("SELECT a.id,a.title,COUNT(v.album_id) AS votes FROM albums a LEFT JOIN album_votes v ON v.album_id=a.id WHERE a.survey_id=? GROUP BY a.id ORDER BY votes DESC,a.title").bind(surveyId),
      env.DB.prepare("SELECT s.id,s.title,a.title AS albumTitle,COUNT(v.song_id) AS votes FROM songs s JOIN albums a ON a.id=s.album_id LEFT JOIN song_votes v ON v.song_id=s.id WHERE a.survey_id=? GROUP BY s.id ORDER BY votes DESC,s.title").bind(surveyId),
      env.DB.prepare("SELECT a.id,a.name,COUNT(v.artist_id) AS votes FROM artists a LEFT JOIN artist_votes v ON v.artist_id=a.id WHERE a.survey_id=? GROUP BY a.id ORDER BY votes DESC,a.name").bind(surveyId),
    ]);
    const [ivrPrompts, managers, readiness, surveys] = await Promise.all([readIvrPrompts(env), readAdminEmails(env), pollReadiness(env, surveyId), listSurveys(env)]);
    const activeSurvey = surveys.surveys.find((item) => item.id === surveyId) ?? null;
    let suspicious: { fingerprint: string; count: number; voters: string[] }[] = [];
    try {
      const dupFp = await env.DB.prepare("SELECT fingerprint, COUNT(*) AS cnt, GROUP_CONCAT(voter_key, ', ') AS voters FROM ballots WHERE survey_id=? AND fingerprint IS NOT NULL AND fingerprint != '' GROUP BY fingerprint HAVING cnt > 1 ORDER BY cnt DESC LIMIT 50").bind(surveyId).all<{ fingerprint: string; cnt: number; voters: string }>();
      suspicious = dupFp.results.map((r) => ({ fingerprint: r.fingerprint, count: r.cnt, voters: r.voters.split(", ") }));
    } catch { /* fingerprint column may not exist yet */ }
    return json({ albums: albums.results, songs: songs.results, artists: artists.results, votes: ballots.results[0] ?? { total: 0, phone: 0, site: 0 }, settings: settings.results[0] ?? DEFAULT_SETTINGS, readiness, ivrPrompts, managers, yemotConnected: Boolean(env.YEMOT_TOKEN), ttsAvailable: ttsConfigured(env), results: { albums: albumResults.results, songs: songResults.results, artists: artistResults.results }, surveys: surveys.surveys, activeSurvey, suspicious });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/archives") {
    const listed = await env.MEDIA.list({ prefix: ARCHIVE_PREFIX });
    const archives = await Promise.all(listed.objects.map(async (object) => {
      const snapshot = await readPollSnapshot(env, object.key);
      return snapshot ? { key: object.key, name: snapshot.name, createdAt: snapshot.createdAt, votes: snapshot.ballots.length, albums: snapshot.albums.length, songs: snapshot.songs.length, artists: snapshot.artists.length } : null;
    }));
    return json({ archives: archives.filter(Boolean).sort((a, b) => Number(b?.createdAt) - Number(a?.createdAt)) });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/backup") {
    const backup = await createPollSnapshot(env, text(url.searchParams.get("name")), surveyId);
    return new Response(JSON.stringify(backup.snapshot, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="rosh-berosh-backup-${backup.createdAt}.json"` } });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/archive") {
    const body = await request.json<{ name?: string; restoreKey?: string }>();
    if (!body.restoreKey) return json({ ok: true, archive: await createPollSnapshot(env, text(body.name), surveyId) });
    const snapshot = await readPollSnapshot(env, body.restoreKey);
    if (!snapshot) return json({ error: "הסקר שבארכיון לא נמצא." }, 404);
    const autoBackup = await createPollSnapshot(env, "גיבוי אוטומטי לפני שחזור", surveyId);
    await clearCurrentPoll(env, surveyId);
    try {
      const statements = [
        ...snapshot.albums.map((row) => env.DB.prepare("INSERT INTO albums (id,survey_id,title,artist_name,cover_url,position,active) VALUES (?,?,?,?,?,?,?)").bind(row.id, surveyId, row.title, row.artist_name, row.cover_url, row.position, row.active)),
        ...snapshot.songs.map((row) => env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,cover_url,preview_start,preview_end,position,active) VALUES (?,?,?,?,?,?,?,?,?)").bind(row.id, row.album_id, row.title, row.audio_url, row.cover_url || null, row.preview_start || 0, row.preview_end || 0, row.position, row.active)),
        ...snapshot.artists.map((row) => env.DB.prepare("INSERT INTO artists (id,survey_id,name,image_url,position,active) VALUES (?,?,?,?,?,?)").bind(row.id, surveyId, row.name, row.image_url, row.position, row.active)),
        ...snapshot.ballots.map((row) => env.DB.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,fingerprint,created_at) VALUES (?,?,?,?,?,?)").bind(row.id, surveyId, row.voter_key, row.channel, row.fingerprint || null, row.created_at)),
        ...snapshot.albumVotes.map((row) => env.DB.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES (?,?)").bind(row.ballot_id, row.album_id)),
        ...snapshot.songVotes.map((row) => env.DB.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES (?,?,?)").bind(row.ballot_id, row.album_id, row.song_id)),
        ...snapshot.artistVotes.map((row) => env.DB.prepare("INSERT INTO artist_votes (ballot_id,artist_id) VALUES (?,?)").bind(row.ballot_id, row.artist_id)),
      ];
      for (let index = 0; index < statements.length; index += 80) await env.DB.batch(statements.slice(index, index + 80));
      const settings = snapshot.settings;
      if (settings) await env.DB.prepare("UPDATE poll_settings SET voting_open=0,albums_enabled=?,albums_min=?,albums_max=?,songs_enabled=?,songs_min=?,songs_max=?,artists_enabled=?,artists_min=?,artists_max=? WHERE id=?").bind(settings.albums_enabled, settings.albums_min, settings.albums_max, settings.songs_enabled, settings.songs_min, settings.songs_max, settings.artists_enabled, settings.artists_min, settings.artists_max, surveyId).run();
    } catch (error) {
      console.error("restore failed, rolling back from auto-backup", error);
      await clearCurrentPoll(env, surveyId);
      const rollback = autoBackup.snapshot;
      const rbStatements = [
        ...rollback.albums.map((row) => env.DB.prepare("INSERT INTO albums (id,survey_id,title,artist_name,cover_url,position,active) VALUES (?,?,?,?,?,?,?)").bind(row.id, surveyId, row.title, row.artist_name, row.cover_url, row.position, row.active)),
        ...rollback.songs.map((row) => env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,cover_url,preview_start,preview_end,position,active) VALUES (?,?,?,?,?,?,?,?,?)").bind(row.id, row.album_id, row.title, row.audio_url, row.cover_url || null, row.preview_start || 0, row.preview_end || 0, row.position, row.active)),
        ...rollback.artists.map((row) => env.DB.prepare("INSERT INTO artists (id,survey_id,name,image_url,position,active) VALUES (?,?,?,?,?,?)").bind(row.id, surveyId, row.name, row.image_url, row.position, row.active)),
        ...rollback.ballots.map((row) => env.DB.prepare("INSERT INTO ballots (id,survey_id,voter_key,channel,fingerprint,created_at) VALUES (?,?,?,?,?,?)").bind(row.id, surveyId, row.voter_key, row.channel, row.fingerprint || null, row.created_at)),
        ...rollback.albumVotes.map((row) => env.DB.prepare("INSERT INTO album_votes (ballot_id,album_id) VALUES (?,?)").bind(row.ballot_id, row.album_id)),
        ...rollback.songVotes.map((row) => env.DB.prepare("INSERT INTO song_votes (ballot_id,album_id,song_id) VALUES (?,?,?)").bind(row.ballot_id, row.album_id, row.song_id)),
        ...rollback.artistVotes.map((row) => env.DB.prepare("INSERT INTO artist_votes (ballot_id,artist_id) VALUES (?,?)").bind(row.ballot_id, row.artist_id)),
      ];
      for (let index = 0; index < rbStatements.length; index += 80) await env.DB.batch(rbStatements.slice(index, index + 80));
      const rbSettings = rollback.settings;
      if (rbSettings) await env.DB.prepare("UPDATE poll_settings SET voting_open=?,albums_enabled=?,albums_min=?,albums_max=?,songs_enabled=?,songs_min=?,songs_max=?,artists_enabled=?,artists_min=?,artists_max=? WHERE id=?").bind(rbSettings.voting_open, rbSettings.albums_enabled, rbSettings.albums_min, rbSettings.albums_max, rbSettings.songs_enabled, rbSettings.songs_min, rbSettings.songs_max, rbSettings.artists_enabled, rbSettings.artists_min, rbSettings.artists_max, surveyId).run();
      return json({ error: "השחזור נכשל — המצב הקודם שוחזר מגיבוי אוטומטי." }, 500);
    }
    return json({ ok: true });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/archive") {
    const body = await request.json<{ key?: string }>();
    if (!body.key?.startsWith(ARCHIVE_PREFIX)) return json({ error: "ארכיון לא תקין." }, 400);
    await env.MEDIA.delete(body.key);
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/managers") {
    const body = await request.json<{ email?: string }>();
    const email = text(body.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "כתובת הדוא״ל אינה תקינה." }, 400);
    const managers = await readAdminEmails(env);
    if (!managers.includes(email)) managers.push(email);
    return json({ ok: true, managers: await saveAdminEmails(env, managers) });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/managers") {
    const body = await request.json<{ email?: string }>();
    const email = text(body.email).toLowerCase();
    if (!email) return json({ error: "כתובת מנהל חסרה." }, 400);
    if (email === currentAdmin.email) return json({ error: "אי אפשר להסיר את החשבון שבו אתם מחוברים." }, 400);
    const protectedEmails = new Set(["o0534169095@gmail.com", "0534169095@xn--4dbjbascrao3i.com"]);
    if (protectedEmails.has(email)) return json({ error: "זהו חשבון מנהל ראשי ואי אפשר להסירו." }, 400);
    const managers = (await readAdminEmails(env)).filter((item) => item !== email);
    return json({ ok: true, managers: await saveAdminEmails(env, managers) });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/ivr-prompt") {
    const form = await request.formData();
    const file = form.get("file"), key = text(form.get("key")), label = text(form.get("label"));
    if (!(file instanceof File) || !key || !label || !/^[a-z0-9:_-]+$/i.test(key)) return json({ error: "קובץ או סוג קריינות חסרים." }, 400);
    if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|ogg)$/i.test(file.name)) return json({ error: "יש לבחור קובץ שמע." }, 415);
    if (file.size > 25 * 1024 * 1024) return json({ error: "קובץ הקריינות גדול מ־25MB." }, 413);
    const mediaKey = `ivr-prompts/${safeName(key)}-${crypto.randomUUID()}-${safeName(file.name)}`;
    await env.MEDIA.put(mediaKey, file.stream(), { httpMetadata: { contentType: file.type || "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { originalName: file.name, promptKey: key } });
    const sync = await syncPromptToYemot(env, key, file);
    const prompts = await readIvrPrompts(env), previous = prompts.find((prompt) => prompt.key === key);
    const next = prompts.filter((prompt) => prompt.key !== key);
    next.push({ key, label, audioUrl: mediaUrl(mediaKey), yemotPath: sync.path || previous?.yemotPath || "", updatedAt: Date.now() });
    await saveIvrPrompts(env, next);
    if (previous?.audioUrl.startsWith("/media/") && previous.audioUrl !== mediaUrl(mediaKey)) {
      await env.MEDIA.delete(decodeURIComponent(previous.audioUrl.slice(7)));
    }
    return json({ ok: true, warning: sync.warning, yemotPath: sync.path || previous?.yemotPath || "" });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/ivr-prompt") {
    const body = await request.json<{ key?: string }>();
    if (!body.key) return json({ error: "סוג הקריינות חסר." }, 400);
    const prompts = await readIvrPrompts(env), current = prompts.find((prompt) => prompt.key === body.key);
    if (current?.audioUrl.startsWith("/media/")) await env.MEDIA.delete(decodeURIComponent(current.audioUrl.slice(7)));
    await saveIvrPrompts(env, prompts.filter((prompt) => prompt.key !== body.key));
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/ivr-tts-preview") {
    const body = await request.json<{ label?: string }>();
    const label = text(body.label);
    if (!label) return json({ error: "טקסט חסר." }, 400);
    if (!ttsConfigured(env)) return json({ error: "שירות ה-TTS אינו מוגדר." }, 503);
    try {
      const audio = await generateTtsAudio(env, label);
      return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
    } catch (error) { return json({ error: error instanceof Error ? error.message : "יצירת הקריינות נכשלה." }, 502); }
  }

  if (request.method === "POST" && url.pathname === "/api/admin/ivr-tts") {
    const body = await request.json<{ key?: string; label?: string }>();
    const key = text(body.key), label = text(body.label);
    if (!key || !label) return json({ error: "מפתח או טקסט חסרים." }, 400);
    if (!ttsConfigured(env)) return json({ error: "שירות ה-TTS אינו מוגדר." }, 503);
    let audioBuffer: ArrayBuffer;
    try { audioBuffer = await generateTtsAudio(env, label); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "יצירת הקריינות נכשלה." }, 502); }
    const mediaKey = `ivr-prompts/${safeName(key)}-${crypto.randomUUID()}-tts.mp3`;
    await env.MEDIA.put(mediaKey, audioBuffer, { httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { promptKey: key } });
    const ttsFile = new File([audioBuffer], "tts.mp3", { type: "audio/mpeg" });
    const sync = await syncPromptToYemot(env, key, ttsFile);
    const prompts = await readIvrPrompts(env), previous = prompts.find((p) => p.key === key);
    const next = prompts.filter((p) => p.key !== key);
    next.push({ key, label, audioUrl: mediaUrl(mediaKey), yemotPath: sync.path || previous?.yemotPath || "", updatedAt: Date.now() });
    await saveIvrPrompts(env, next);
    if (previous?.audioUrl.startsWith("/media/") && previous.audioUrl !== mediaUrl(mediaKey)) await env.MEDIA.delete(decodeURIComponent(previous.audioUrl.slice(7)));
    return json({ ok: true, warning: sync.warning });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/reorder") {
    const body = await request.json<{ kind?: string; ids?: string[] }>();
    if (!Array.isArray(body.ids) || !body.ids.length || !["album", "artist", "song"].includes(body.kind ?? "")) return json({ error: "בקשה לא תקינה." }, 400);
    if (body.kind === "song") {
      await env.DB.batch(body.ids.map((id, index) => env.DB.prepare("UPDATE songs SET position=? WHERE id=?").bind(index, id)));
    } else {
      const table = body.kind === "album" ? "albums" : "artists";
      await env.DB.batch(body.ids.map((id, index) => env.DB.prepare(`UPDATE ${table} SET position=? WHERE id=? AND survey_id=?`).bind(index, id, surveyId)));
    }
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/settings") {
    const body = await request.json<Record<string, unknown>>();
    const pairs = [
      ["albums", number(body.albumsMin, 5), number(body.albumsMax, 5)],
      ["songs", number(body.songsMin, 1), number(body.songsMax, 1)],
      ["artists", number(body.artistsMin, 1), number(body.artistsMax, 3)],
    ] as const;
    if (pairs.some(([, min, max]) => min < 0 || max < min || max > 50)) return json({ error: "טווחי הבחירה אינם תקינים." }, 400);
    if (flag(body.songsEnabled) && !flag(body.albumsEnabled)) return json({ error: "אי אפשר לבחור שירים בלי לבחור אלבומים." }, 400);
    if (flag(body.votingOpen)) {
      const readiness = await pollReadiness(env, surveyId);
      if (!readiness.ready) return json({ error: `אי אפשר לפרסם עדיין: ${readiness.warnings.join(", ")}.`, readiness }, 400);
    }
    await env.DB.prepare(`UPDATE poll_settings SET voting_open=?, albums_enabled=?, albums_min=?, albums_max=?, songs_enabled=?, songs_min=?, songs_max=?, artists_enabled=?, artists_min=?, artists_max=? WHERE id=?`)
      .bind(flag(body.votingOpen) ? 1 : 0, flag(body.albumsEnabled) ? 1 : 0, pairs[0][1], pairs[0][2], flag(body.songsEnabled) ? 1 : 0, pairs[1][1], pairs[1][2], flag(body.artistsEnabled) ? 1 : 0, pairs[2][1], pairs[2][2], surveyId).run();
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/reset-votes") {
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM ballots WHERE survey_id=?").bind(surveyId).first<{ total: number }>();
    if (!count?.total) return json({ ok: true, deleted: 0 });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM song_votes WHERE ballot_id IN (SELECT id FROM ballots WHERE survey_id=?)").bind(surveyId),
      env.DB.prepare("DELETE FROM album_votes WHERE ballot_id IN (SELECT id FROM ballots WHERE survey_id=?)").bind(surveyId),
      env.DB.prepare("DELETE FROM artist_votes WHERE ballot_id IN (SELECT id FROM ballots WHERE survey_id=?)").bind(surveyId),
      env.DB.prepare("DELETE FROM ballots WHERE survey_id=?").bind(surveyId),
    ]);
    return json({ ok: true, deleted: count.total });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/poll") {
    const archive = url.searchParams.get("skipArchive") === "1" ? null : await createPollSnapshot(env, "ארכיון אוטומטי לפני מחיקה", surveyId);
    await clearCurrentPoll(env, surveyId);
    return json({ ok: true, archive });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/suggest-chorus") {
    const body = await request.json<{ songId?: string; audioUrl?: string }>();
    let audioUrl = text(body.audioUrl);
    const songId = text(body.songId);
    if (songId && !audioUrl) {
      const song = await env.DB.prepare("SELECT audio_url AS audioUrl FROM songs WHERE id=?").bind(songId).first<{ audioUrl?: string }>();
      audioUrl = text(song?.audioUrl);
    }
    if (!audioUrl) return json({ error: "לשיר אין קובץ שמע לניתוח." }, 400);
    try {
      const suggestion = await suggestChorusAI(env, audioUrl);
      return json({ ok: true, source: "ai", ...suggestion });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "ניתוח הפזמון נכשל.", aiConfigured: Boolean(env.AI_API_KEY) }, 502);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/admin/catalog") {
    const body = await request.json<Record<string, unknown>>();
    const kind = text(body.kind);
    const id = text(body.id) || crypto.randomUUID();
    if (kind === "album") {
      const title = text(body.title), artistName = text(body.artistName);
      if (!title || !artistName) return json({ error: "חובה להזין שם אלבום ושם אמן." }, 400);
      await env.DB.prepare("INSERT INTO albums (id,survey_id,title,artist_name,cover_url,position,active) VALUES (?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist_name=excluded.artist_name,cover_url=COALESCE(excluded.cover_url,albums.cover_url),position=excluded.position")
        .bind(id, surveyId, title, artistName, text(body.coverUrl) || null, number(body.position)).run();
    } else if (kind === "song") {
      const title = text(body.title), albumId = text(body.albumId);
      if (!title || !albumId) return json({ error: "חובה לבחור אלבום ולהזין שם שיר." }, 400);
      await env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,preview_start,preview_end,position,active) VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET album_id=excluded.album_id,title=excluded.title,audio_url=COALESCE(excluded.audio_url,songs.audio_url),preview_start=excluded.preview_start,preview_end=excluded.preview_end,position=excluded.position")
        .bind(id, albumId, title, text(body.audioUrl) || null, number(body.previewStart), number(body.previewEnd), number(body.position)).run();
    } else if (kind === "artist") {
      const name = text(body.name);
      if (!name) return json({ error: "חובה להזין שם זמר." }, 400);
      await env.DB.prepare("INSERT INTO artists (id,survey_id,name,image_url,position,active) VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,image_url=COALESCE(excluded.image_url,artists.image_url),position=excluded.position")
        .bind(id, surveyId, name, text(body.imageUrl) || null, number(body.position)).run();
    } else return json({ error: "סוג פריט לא מוכר." }, 400);
    return json({ ok: true, id });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/media") {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "קובץ חסר." }, 400);
    const kind = text(form.get("kind"));
    const artistId = text(form.get("artistId"));
    if (kind === "artist" || artistId) {
      if (!artistId) return json({ error: "לא נבחר זמר." }, 400);
      if ((!file.type.startsWith("image/") && !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) || file.type.includes("svg")) return json({ error: "יש לבחור קובץ תמונה (לא SVG)." }, 415);
      if (file.size > 15 * 1024 * 1024) return json({ error: "התמונה גדולה מ־15MB." }, 413);
      const artist = await env.DB.prepare("SELECT image_url AS imageUrl FROM artists WHERE id=?").bind(artistId).first<{ imageUrl?: string }>();
      if (!artist) return json({ error: "הזמר לא נמצא." }, 404);
      const imageKey = `artists/${artistId}/image-${crypto.randomUUID()}-${safeName(file.name)}`;
      await env.MEDIA.put(imageKey, file.stream(), { httpMetadata: { contentType: file.type || "image/jpeg", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { originalName: file.name, artistId } });
      const imageUrl = mediaUrl(imageKey);
      await env.DB.prepare("UPDATE artists SET image_url=? WHERE id=?").bind(imageUrl, artistId).run();
      await deleteMediaUrls(env, [artist.imageUrl]);
      return json({ ok: true, url: imageUrl });
    }
    const albumId = text(form.get("albumId"));
    if (kind === "cover") {
      if (!albumId) return json({ error: "לא נבחר אלבום." }, 400);
      if ((!file.type.startsWith("image/") && !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) || file.type.includes("svg")) return json({ error: "יש לבחור קובץ תמונה (לא SVG)." }, 415);
      if (file.size > 15 * 1024 * 1024) return json({ error: "התמונה גדולה מ־15MB." }, 413);
      const album = await env.DB.prepare("SELECT cover_url AS coverUrl FROM albums WHERE id=?").bind(albumId).first<{ coverUrl?: string }>();
      if (!album) return json({ error: "האלבום לא נמצא." }, 404);
      const coverKey = `albums/${albumId}/cover-${crypto.randomUUID()}-${safeName(file.name)}`;
      await env.MEDIA.put(coverKey, file.stream(), { httpMetadata: { contentType: file.type || "image/jpeg", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { originalName: file.name, albumId } });
      const coverUrl = mediaUrl(coverKey);
      await env.DB.prepare("UPDATE albums SET cover_url=? WHERE id=?").bind(coverUrl, albumId).run();
      await deleteMediaUrls(env, [album.coverUrl]);
      return json({ ok: true, url: coverUrl });
    }
    if (!albumId || kind !== "audio") return json({ error: "קובץ או אלבום חסרים." }, 400);
    if (!file.type.startsWith("audio/") && !/\.(mp3|m4a|wav|ogg|flac|aac|wma)$/i.test(file.name)) return json({ error: "יש לבחור קובץ שמע." }, 415);
    if (file.size > 75 * 1024 * 1024) return json({ error: "הקובץ גדול מ־75MB." }, 413);
    const audioBuffer = await file.arrayBuffer();
    const key = `albums/${albumId}/audio-${crypto.randomUUID()}-${safeName(file.name)}`;
    await env.MEDIA.put(key, audioBuffer, { httpMetadata: { contentType: file.type || "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { originalName: file.name, albumId, kind: "audio" } });
    const audioUrl = mediaUrl(key);
    const songId = crypto.randomUUID();
    const title = text(form.get("title")) || file.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]*/, "");
    let coverUrl: string | null = null;
    const cover = await extractCoverFromAudio(audioBuffer);
    if (cover) {
      const coverKey = `albums/${albumId}/cover-${songId}-${crypto.randomUUID()}.jpg`;
      await env.MEDIA.put(coverKey, cover.data, { httpMetadata: { contentType: cover.mime, cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { songId, albumId } });
      coverUrl = mediaUrl(coverKey);
    }
    await env.DB.prepare("INSERT INTO songs (id,album_id,title,audio_url,cover_url,preview_start,preview_end,position,active) VALUES (?,?,?,?,?,0,0,?,1)")
      .bind(songId, albumId, title, audioUrl, coverUrl, number(form.get("position"))).run();
    return json({ ok: true, id: songId, url: audioUrl, coverUrl });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/media") {
    const body = await request.json<{ albumId?: string; artistId?: string; kind?: string }>();
    if (body.kind === "artist" || body.artistId) {
      if (!body.artistId) return json({ error: "לא נבחר זמר." }, 400);
      const artist = await env.DB.prepare("SELECT image_url AS imageUrl FROM artists WHERE id=?").bind(body.artistId).first<{ imageUrl?: string }>();
      if (!artist) return json({ error: "הזמר לא נמצא." }, 404);
      await env.DB.prepare("UPDATE artists SET image_url=NULL WHERE id=?").bind(body.artistId).run();
      await deleteMediaUrls(env, [artist.imageUrl]);
      return json({ ok: true });
    }
    if (!body.albumId || body.kind !== "cover") return json({ error: "בקשת מחיקת הקובץ אינה תקינה." }, 400);
    const album = await env.DB.prepare("SELECT cover_url AS coverUrl FROM albums WHERE id=?").bind(body.albumId).first<{ coverUrl?: string }>();
    if (!album) return json({ error: "האלבום לא נמצא." }, 404);
    await env.DB.prepare("UPDATE albums SET cover_url=NULL WHERE id=?").bind(body.albumId).run();
    await deleteMediaUrls(env, [album.coverUrl]);
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/toggle") {
    const body = await request.json<{ kind?: string; id?: string; active?: boolean }>();
    const tables: Record<string, string> = { album: "albums", song: "songs", artist: "artists" };
    const table = tables[body.kind ?? ""];
    if (!table || !body.id) return json({ error: "בקשה לא תקינה." }, 400);
    await env.DB.prepare(`UPDATE ${table} SET active = ? WHERE id = ?`).bind(body.active ? 1 : 0, body.id).run();
    return json({ ok: true });
  }

  if (request.method === "DELETE" && url.pathname === "/api/admin/catalog") {
    const body = await request.json<{ kind?: string; id?: string }>();
    if (!body.id || !["album", "song", "artist"].includes(body.kind ?? "")) return json({ error: "בקשה לא תקינה." }, 400);
    if (body.kind === "album") {
      const album = await env.DB.prepare("SELECT cover_url AS coverUrl FROM albums WHERE id=?").bind(body.id).first<{ coverUrl?: string }>();
      const songs = await env.DB.prepare("SELECT audio_url AS audioUrl, cover_url AS coverUrl FROM songs WHERE album_id=?").bind(body.id).all<{ audioUrl?: string; coverUrl?: string }>();
      if (!album) return json({ error: "האלבום כבר אינו קיים." }, 404);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM song_votes WHERE album_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM album_votes WHERE album_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM songs WHERE album_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM albums WHERE id=?").bind(body.id),
      ]);
      await deleteMediaUrls(env, [album.coverUrl, ...songs.results.flatMap((song) => [song.audioUrl, song.coverUrl])]);
    } else if (body.kind === "song") {
      const song = await env.DB.prepare("SELECT audio_url AS audioUrl, cover_url AS coverUrl FROM songs WHERE id=?").bind(body.id).first<{ audioUrl?: string; coverUrl?: string }>();
      if (!song) return json({ error: "השיר כבר אינו קיים." }, 404);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM song_votes WHERE song_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM songs WHERE id=?").bind(body.id),
      ]);
      await deleteMediaUrls(env, [song.audioUrl, song.coverUrl]);
    } else {
      const artist = await env.DB.prepare("SELECT image_url AS imageUrl FROM artists WHERE id=?").bind(body.id).first<{ imageUrl?: string }>();
      if (!artist) return json({ error: "הזמר כבר אינו קיים." }, 404);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM artist_votes WHERE artist_id=?").bind(body.id),
        env.DB.prepare("DELETE FROM artists WHERE id=?").bind(body.id),
      ]);
      await deleteMediaUrls(env, [artist.imageUrl]);
    }
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/export") {
    const kind = url.searchParams.get("kind") || "albums";
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = 500;
    const offset = (page - 1) * pageSize;
    let query: string;
    if (kind === "songs") {
      query = `SELECT s.title, a.title AS albumTitle, COUNT(v.song_id) AS votes FROM songs s JOIN albums a ON a.id=s.album_id LEFT JOIN song_votes v ON v.song_id=s.id WHERE a.survey_id=? GROUP BY s.id ORDER BY votes DESC, s.title LIMIT ${pageSize} OFFSET ${offset}`;
    } else if (kind === "artists") {
      query = `SELECT a.name AS title, '' AS albumTitle, COUNT(v.artist_id) AS votes FROM artists a LEFT JOIN artist_votes v ON v.artist_id=a.id WHERE a.survey_id=? GROUP BY a.id ORDER BY votes DESC, a.name LIMIT ${pageSize} OFFSET ${offset}`;
    } else {
      query = `SELECT a.title, a.artist_name AS albumTitle, COUNT(v.album_id) AS votes FROM albums a LEFT JOIN album_votes v ON v.album_id=a.id WHERE a.survey_id=? GROUP BY a.id ORDER BY votes DESC, a.title LIMIT ${pageSize} OFFSET ${offset}`;
    }
    const rows = await env.DB.prepare(query).bind(surveyId).all();
    return json({ rows: rows.results, page, hasMore: rows.results.length === pageSize });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/extract-covers") {
    const songs = await env.DB.prepare("SELECT s.id, s.album_id AS albumId, s.audio_url AS audioUrl FROM songs s JOIN albums a ON a.id=s.album_id WHERE a.survey_id=? AND s.audio_url IS NOT NULL AND s.audio_url<>'' AND (s.cover_url IS NULL OR s.cover_url='')").bind(surveyId).all<{ id: string; albumId: string; audioUrl: string }>();
    let extracted = 0;
    for (const song of songs.results) {
      const key = keyFromMediaUrl(song.audioUrl);
      if (!key) continue;
      const obj = await env.MEDIA.get(key);
      if (!obj) continue;
      const buf = await obj.arrayBuffer();
      const cover = extractCoverFromAudio(buf);
      if (!cover) continue;
      const coverKey = `albums/${song.albumId}/cover-${song.id}-${crypto.randomUUID()}.jpg`;
      await env.MEDIA.put(coverKey, cover.data, { httpMetadata: { contentType: cover.mime, cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { songId: song.id, albumId: song.albumId } });
      await env.DB.prepare("UPDATE songs SET cover_url=? WHERE id=?").bind(mediaUrl(coverKey), song.id).run();
      extracted++;
    }
    return json({ ok: true, total: songs.results.length, extracted });
  }

  return json({ error: "Not Found" }, 404);
}
