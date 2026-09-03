import { addIvrRecorder, deleteIvrAudioIfUnreferenced, deleteIvrPrompt, readIvrPrompts, readIvrRecorders, removeIvrRecorder, syncPromptToYemot, upsertIvrPrompt } from "./ivr-prompts";
import { normalizePhone } from "./phone";
import { reorderIds, shiftIds } from "./reorder.js";
import { readAdminEmails, saveAdminEmails } from "./auth";
import type { AdminEnv } from "./admin";
import { createPollSnapshot, deleteCatalogItem, deletePollArchive, deleteSurveyData, extractSurveyCovers, generateTtsAudio, listPollArchives, mediaUrl, resetPollVotes, restorePollArchive, safeName, suggestChorusAI, ttsConfigured } from "./admin";

type IvrAdminEnv = AdminEnv;
type Settings = {
  votingOpen: number;
  albumsEnabled: number;
  albumsMin: number;
  albumsMax: number;
  songsEnabled: number;
  songsMin: number;
  songsMax: number;
  artistsEnabled: number;
  artistsMin: number;
  artistsMax: number;
};

type ActionBody = {
  phone?: string;
  action?: string;
  value?: boolean;
  id?: string;
  kind?: "album" | "song" | "artist";
  stage?: "albums" | "songs" | "artists";
  min?: number;
  max?: number;
  key?: string;
  label?: string;
  targetPhone?: string;
  direction?: -1 | 1;
  albumId?: string;
  position?: number;
  start?: number;
  end?: number;
  email?: string;
  limit?: number;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const DEFAULT_SETTINGS: Settings = {
  votingOpen: 0,
  albumsEnabled: 1,
  albumsMin: 5,
  albumsMax: 5,
  songsEnabled: 1,
  songsMin: 1,
  songsMax: 1,
  artistsEnabled: 1,
  artistsMin: 1,
  artistsMax: 3,
};

async function activeSurvey(env: IvrAdminEnv): Promise<{ id: string; name: string }> {
  const current = await env.DB.prepare("SELECT id,name FROM surveys WHERE active=1 ORDER BY created_at DESC LIMIT 1").first<{ id: string; name: string }>();
  if (current) return current;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO surveys (id,name,active) VALUES ('main','הסקר הראשי',1)"),
    env.DB.prepare("INSERT OR IGNORE INTO poll_settings (id) VALUES ('main')"),
  ]);
  return { id: "main", name: "הסקר הראשי" };
}

async function readSettings(env: IvrAdminEnv, surveyId: string): Promise<Settings> {
  return await env.DB.prepare(
    "SELECT voting_open AS votingOpen,albums_enabled AS albumsEnabled,albums_min AS albumsMin,albums_max AS albumsMax,songs_enabled AS songsEnabled,songs_min AS songsMin,songs_max AS songsMax,artists_enabled AS artistsEnabled,artists_min AS artistsMin,artists_max AS artistsMax FROM poll_settings WHERE id=?",
  ).bind(surveyId).first<Settings>() ?? DEFAULT_SETTINGS;
}

async function readiness(env: IvrAdminEnv, surveyId: string, settings: Settings) {
  const [albums, songs, artists] = await env.DB.batch([
    env.DB.prepare("SELECT id,title FROM albums WHERE active=1 AND survey_id=?").bind(surveyId),
    env.DB.prepare("SELECT s.album_id AS albumId,COUNT(*) AS total FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.active=1 AND a.active=1 AND a.survey_id=? GROUP BY s.album_id").bind(surveyId),
    env.DB.prepare("SELECT COUNT(*) AS total FROM artists WHERE active=1 AND survey_id=?").bind(surveyId),
  ]);
  const songCounts = new Map(songs.results.map((row) => [String(row.albumId), Number(row.total || 0)]));
  const missingSongs = settings.songsEnabled
    ? albums.results.filter((album) => (songCounts.get(String(album.id)) || 0) < settings.songsMin).length
    : 0;
  const artistCount = Number(artists.results[0]?.total || 0);
  const warnings: string[] = [];
  if (settings.albumsEnabled && albums.results.length < settings.albumsMin) warnings.push(`צריך לפחות ${settings.albumsMin} אלבומים פעילים`);
  if (settings.songsEnabled && missingSongs) warnings.push(`${missingSongs} אלבומים בלי מספיק שירים פעילים`);
  if (settings.artistsEnabled && artistCount < settings.artistsMin) warnings.push(`צריך לפחות ${settings.artistsMin} זמרים פעילים`);
  return {
    ready: warnings.length === 0,
    warnings,
    counts: {
      albums: albums.results.length,
      songs: songs.results.reduce((sum, row) => sum + Number(row.total || 0), 0),
      artists: artistCount,
    },
  };
}

function validateSettings(settings: Settings): string {
  const stages = [
    [settings.albumsEnabled, settings.albumsMin, settings.albumsMax],
    [settings.songsEnabled, settings.songsMin, settings.songsMax],
    [settings.artistsEnabled, settings.artistsMin, settings.artistsMax],
  ];
  if (!settings.albumsEnabled && !settings.songsEnabled && !settings.artistsEnabled) return "צריך להשאיר לפחות שלב הצבעה אחד פעיל.";
  if (settings.songsEnabled && !settings.albumsEnabled) return "אי אפשר להפעיל בחירת שירים בלי בחירת אלבומים.";
  if (stages.some(([enabled, min, max]) => enabled && (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 50))) return "כמויות הבחירה אינן תקינות.";
  return "";
}

async function saveSettings(env: IvrAdminEnv, surveyId: string, settings: Settings): Promise<void> {
  await env.DB.prepare(
    "UPDATE poll_settings SET voting_open=?,albums_enabled=?,albums_min=?,albums_max=?,songs_enabled=?,songs_min=?,songs_max=?,artists_enabled=?,artists_min=?,artists_max=? WHERE id=?",
  ).bind(
    settings.votingOpen,
    settings.albumsEnabled,
    settings.albumsMin,
    settings.albumsMax,
    settings.songsEnabled,
    settings.songsMin,
    settings.songsMax,
    settings.artistsEnabled,
    settings.artistsMin,
    settings.artistsMax,
    surveyId,
  ).run();
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function requireRecorder(env: IvrAdminEnv, rawPhone: string): Promise<{ phone: string; recorders: string[] } | null> {
  const phone = normalizePhone(rawPhone);
  const recorders = await readIvrRecorders(env);
  return phone && recorders.includes(phone) ? { phone, recorders } : null;
}

async function overview(env: IvrAdminEnv, callerPhone: string): Promise<Response> {
  const access = await requireRecorder(env, callerPhone);
  if (!access) return json({ error: "מספר הטלפון אינו מורשה לניהול." }, 403);
  const survey = await activeSurvey(env);
  const [surveys, settings, albums, songs, artists, votes, albumResults, songResults, artistResults] = await env.DB.batch([
    env.DB.prepare("SELECT s.id,s.name,s.active,COALESCE(p.voting_open,0) AS votingOpen FROM surveys s LEFT JOIN poll_settings p ON p.id=s.id ORDER BY s.active DESC,s.created_at DESC"),
    env.DB.prepare("SELECT voting_open AS votingOpen,albums_enabled AS albumsEnabled,albums_min AS albumsMin,albums_max AS albumsMax,songs_enabled AS songsEnabled,songs_min AS songsMin,songs_max AS songsMax,artists_enabled AS artistsEnabled,artists_min AS artistsMin,artists_max AS artistsMax FROM poll_settings WHERE id=?").bind(survey.id),
    env.DB.prepare("SELECT id,title,artist_name AS artistName,active FROM albums WHERE survey_id=? ORDER BY position,title").bind(survey.id),
    env.DB.prepare("SELECT s.id,s.album_id AS albumId,s.title,s.active,s.preview_start AS previewStart,s.preview_end AS previewEnd,s.audio_url AS audioUrl FROM songs s JOIN albums a ON a.id=s.album_id WHERE a.survey_id=? ORDER BY s.album_id,s.position,s.title").bind(survey.id),
    env.DB.prepare("SELECT id,name,active FROM artists WHERE survey_id=? ORDER BY position,name").bind(survey.id),
    env.DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN channel='phone' THEN 1 ELSE 0 END) AS phone,SUM(CASE WHEN channel='site' THEN 1 ELSE 0 END) AS site FROM ballots WHERE survey_id=?").bind(survey.id),
    env.DB.prepare("SELECT a.title AS label,COUNT(v.album_id) AS votes FROM albums a LEFT JOIN album_votes v ON v.album_id=a.id WHERE a.survey_id=? GROUP BY a.id ORDER BY votes DESC,a.title LIMIT 5").bind(survey.id),
    env.DB.prepare("SELECT s.title AS label,COUNT(v.song_id) AS votes FROM songs s JOIN albums a ON a.id=s.album_id LEFT JOIN song_votes v ON v.song_id=s.id WHERE a.survey_id=? GROUP BY s.id ORDER BY votes DESC,s.title LIMIT 5").bind(survey.id),
    env.DB.prepare("SELECT a.name AS label,COUNT(v.artist_id) AS votes FROM artists a LEFT JOIN artist_votes v ON v.artist_id=a.id WHERE a.survey_id=? GROUP BY a.id ORDER BY votes DESC,a.name LIMIT 5").bind(survey.id),
  ]);
  const currentSettings = (settings.results[0] as unknown as Settings | undefined) ?? DEFAULT_SETTINGS;
  const [prompts, currentReadiness, archives, managers] = await Promise.all([readIvrPrompts(env), readiness(env, survey.id, currentSettings), listPollArchives(env), readAdminEmails(env)]);
  return json({
    activeSurvey: survey,
    surveys: surveys.results,
    settings: currentSettings,
    albums: albums.results,
    songs: songs.results,
    artists: artists.results,
    votes: votes.results[0] ?? { total: 0, phone: 0, site: 0 },
    results: { albums: albumResults.results, songs: songResults.results, artists: artistResults.results },
    readiness: currentReadiness,
    prompts,
    recorders: access.recorders,
    managers,
    archives: archives.slice(0, 50),
    services: { tts: ttsConfigured(env), ai: Boolean(env.AI_API_KEY) },
  });
}

async function orderedItems(env: IvrAdminEnv, surveyId: string, kind: "album" | "song" | "artist", id: string): Promise<{ id: string }[] | null> {
  if (kind === "album") return (await env.DB.prepare("SELECT id FROM albums WHERE survey_id=? ORDER BY position,title").bind(surveyId).all<{ id: string }>()).results;
  if (kind === "artist") return (await env.DB.prepare("SELECT id FROM artists WHERE survey_id=? ORDER BY position,name").bind(surveyId).all<{ id: string }>()).results;
  const song = await env.DB.prepare("SELECT s.album_id AS albumId FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.id=? AND a.survey_id=?").bind(id, surveyId).first<{ albumId: string }>();
  if (!song) return null;
  return (await env.DB.prepare("SELECT id FROM songs WHERE album_id=? ORDER BY position,title").bind(song.albumId).all<{ id: string }>()).results;
}

async function saveOrder(env: IvrAdminEnv, kind: "album" | "song" | "artist", ids: string[]): Promise<void> {
  const table = kind === "album" ? "albums" : kind === "artist" ? "artists" : "songs";
  await env.DB.batch(ids.map((id, position) => env.DB.prepare(`UPDATE ${table} SET position=? WHERE id=?`).bind(position, id)));
}

// A prompt key names the item it narrates, so the phone never has to dictate text.
async function promptLabel(env: IvrAdminEnv, surveyId: string, key: string): Promise<string> {
  const [kind, id] = key.split(":");
  if (!id) return "";
  if (kind === "album" || kind === "album-name") {
    const album = await env.DB.prepare("SELECT title FROM albums WHERE id=? AND survey_id=?").bind(id, surveyId).first<{ title: string }>();
    return album?.title ?? "";
  }
  if (kind === "artist" || kind === "artist-name") {
    const artist = await env.DB.prepare("SELECT name FROM artists WHERE id=? AND survey_id=?").bind(id, surveyId).first<{ name: string }>();
    return artist?.name ?? "";
  }
  if (kind === "song" || kind === "song-name") {
    const song = await env.DB.prepare("SELECT s.title FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.id=? AND a.survey_id=?").bind(id, surveyId).first<{ title: string }>();
    return song?.title ?? "";
  }
  return "";
}

async function saveTtsPrompt(env: IvrAdminEnv, key: string, label: string): Promise<void> {
  const audio = await generateTtsAudio(env, label);
  const mediaKey = `ivr-prompts/${safeName(key)}-${crypto.randomUUID()}-tts.mp3`;
  await env.MEDIA.put(mediaKey, audio, { httpMetadata: { contentType: "audio/mpeg", cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { promptKey: key } });
  const sync = await syncPromptToYemot(env, key, new File([audio], "tts.mp3", { type: "audio/mpeg" }));
  const prompts = await readIvrPrompts(env), previous = prompts.find((prompt) => prompt.key === key);
  await upsertIvrPrompt(env, { key, label, audioUrl: mediaUrl(mediaKey), yemotPath: sync.path || previous?.yemotPath || "", updatedAt: Date.now() });
  if (previous?.audioUrl !== mediaUrl(mediaKey)) await deleteIvrAudioIfUnreferenced(env, previous?.audioUrl);
}

async function action(env: IvrAdminEnv, body: ActionBody): Promise<Response> {
  const access = await requireRecorder(env, body.phone || "");
  if (!access) return json({ error: "מספר הטלפון אינו מורשה לניהול." }, 403);

  if (body.action === "add-recorder") {
    const targetPhone = normalizePhone(body.targetPhone || "");
    if (!targetPhone) return json({ error: "מספר הטלפון שהוקש אינו תקין." }, 400);
    const next = await addIvrRecorder(env, targetPhone);
    return json({ ok: true, message: "המספר נוסף לרשימת המקליטים המורשים.", recorders: next });
  }

  if (body.action === "remove-recorder") {
    const targetPhone = normalizePhone(body.targetPhone || "");
    if (!targetPhone || !access.recorders.includes(targetPhone)) return json({ error: "המספר אינו נמצא ברשימת המקליטים." }, 404);
    if (targetPhone === access.phone) return json({ error: "אי אפשר להסיר דרך השיחה את המספר שממנו אתם מנהלים כעת." }, 400);
    const removed = await removeIvrRecorder(env, targetPhone);
    if (!removed.removed) return json({ error: removed.reason === "last" ? "אי אפשר להסיר את המספר המורשה האחרון." : "המספר אינו נמצא ברשימת המקליטים." }, removed.reason === "last" ? 400 : 404);
    return json({ ok: true, message: "הרשאת ההקלטה של המספר הוסרה.", recorders: removed.recorders });
  }

  const survey = await activeSurvey(env);

  if (body.action === "create-survey") {
    const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM surveys").first<{ total: number }>();
    const id = crypto.randomUUID();
    const name = `סקר טלפוני ${Number(total?.total || 0) + 1}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO surveys (id,name,active) VALUES (?,?,0)").bind(id, name),
      env.DB.prepare("INSERT INTO poll_settings (id,voting_open) VALUES (?,0)").bind(id),
    ]);
    return json({ ok: true, message: `${name} נוצר כטיוטה.`, id });
  }

  if (body.action === "delete-survey") {
    const id = String(body.id || "").trim();
    try { await deleteSurveyData(env, id); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "מחיקת הסקר נכשלה." }, 400); }
    return json({ ok: true, message: "הסקר נמחק." });
  }

  if (body.action === "set-voting-open") {
    const settings = await readSettings(env, survey.id);
    const next = { ...settings, votingOpen: body.value ? 1 : 0 };
    if (next.votingOpen) {
      const currentReadiness = await readiness(env, survey.id, next);
      if (!currentReadiness.ready) return json({ error: `אי אפשר לפתוח את ההצבעה: ${currentReadiness.warnings.join(", ")}.` }, 400);
    }
    await saveSettings(env, survey.id, next);
    if (settings.votingOpen && !next.votingOpen) await deleteR2Prefix(env.MEDIA, `ivr-progress/${survey.id}/`);
    return json({ ok: true, message: next.votingOpen ? "ההצבעה נפתחה." : "ההצבעה נסגרה." });
  }

  if (body.action === "activate-survey") {
    const id = String(body.id || "").trim();
    const target = id ? await env.DB.prepare("SELECT id,name FROM surveys WHERE id=?").bind(id).first<{ id: string; name: string }>() : null;
    if (!target) return json({ error: "הסקר לא נמצא." }, 404);
    const targetSettings = await readSettings(env, id);
    if (targetSettings.votingOpen) {
      const targetReadiness = await readiness(env, id, targetSettings);
      if (!targetReadiness.ready) return json({ error: `אי אפשר להפעיל סקר פתוח שאינו מוכן: ${targetReadiness.warnings.join(", ")}.` }, 400);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE surveys SET active=0"),
      env.DB.prepare("UPDATE surveys SET active=1 WHERE id=?").bind(id),
    ]);
    if (survey.id !== id) await deleteR2Prefix(env.MEDIA, `ivr-progress/${survey.id}/`);
    return json({ ok: true, message: `הסקר ${target.name} הופעל.` });
  }

  if (body.action === "set-stage-enabled" || body.action === "set-quota") {
    const stage = body.stage;
    if (!stage || !["albums", "songs", "artists"].includes(stage)) return json({ error: "שלב ההצבעה אינו תקין." }, 400);
    const settings = await readSettings(env, survey.id);
    const next = { ...settings };
    const enabledKey = `${stage}Enabled` as "albumsEnabled" | "songsEnabled" | "artistsEnabled";
    const minKey = `${stage}Min` as "albumsMin" | "songsMin" | "artistsMin";
    const maxKey = `${stage}Max` as "albumsMax" | "songsMax" | "artistsMax";
    if (body.action === "set-stage-enabled") next[enabledKey] = body.value ? 1 : 0;
    else {
      next[minKey] = Number(body.min);
      next[maxKey] = Number(body.max);
    }
    const invalid = validateSettings(next);
    if (invalid) return json({ error: invalid }, 400);
    if (next.votingOpen) {
      const currentReadiness = await readiness(env, survey.id, next);
      if (!currentReadiness.ready) return json({ error: `השינוי לא נשמר: ${currentReadiness.warnings.join(", ")}.` }, 400);
    }
    await saveSettings(env, survey.id, next);
    return json({ ok: true, message: "הגדרות ההצבעה עודכנו." });
  }

  if (body.action === "toggle-item") {
    const id = String(body.id || "").trim();
    const lookups = {
      album: "SELECT a.id,a.title AS label,a.active FROM albums a WHERE a.id=? AND a.survey_id=?",
      song: "SELECT s.id,s.title AS label,s.active FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.id=? AND a.survey_id=?",
      artist: "SELECT a.id,a.name AS label,a.active FROM artists a WHERE a.id=? AND a.survey_id=?",
    } as const;
    const tables = { album: "albums", song: "songs", artist: "artists" } as const;
    const kind = body.kind;
    if (!kind || !id) return json({ error: "הפריט לא נבחר." }, 400);
    const item = await env.DB.prepare(lookups[kind]).bind(id, survey.id).first<{ id: string; label: string; active: number }>();
    if (!item) return json({ error: "הפריט לא נמצא בסקר הפעיל." }, 404);
    const nextActive = body.value ? 1 : 0;
    const settings = await readSettings(env, survey.id);
    if (!nextActive && settings.votingOpen) return json({ error: "כדי להשבית פריט יש לסגור קודם את ההצבעה." }, 409);
    await env.DB.prepare(`UPDATE ${tables[kind]} SET active=? WHERE id=?`).bind(nextActive, id).run();
    if (settings.votingOpen) {
      const currentReadiness = await readiness(env, survey.id, settings);
      if (!currentReadiness.ready) {
        await env.DB.prepare(`UPDATE ${tables[kind]} SET active=? WHERE id=?`).bind(item.active, id).run();
        return json({ error: `השינוי לא נשמר: ${currentReadiness.warnings.join(", ")}.` }, 400);
      }
    }
    return json({ ok: true, message: `${item.label} ${nextActive ? "הופעל" : "הושבת"}.` });
  }

  if (body.action === "delete-item") {
    const kind = body.kind, id = String(body.id || "").trim();
    if (!kind || !id) return json({ error: "הפריט לא נבחר." }, 400);
    try { await deleteCatalogItem(env, survey.id, kind, id); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "מחיקת הפריט נכשלה." }, 400); }
    return json({ ok: true, message: "הפריט נמחק." });
  }

  if (body.action === "move-item") {
    const kind = body.kind, id = String(body.id || "").trim(), direction = body.direction === -1 ? -1 : body.direction === 1 ? 1 : 0;
    if (!kind || !id || !direction) return json({ error: "הפריט או כיוון ההזזה אינם תקינים." }, 400);
    const settings = await readSettings(env, survey.id);
    if (settings.votingOpen) return json({ error: "כדי לשנות סדר יש לסגור קודם את ההצבעה." }, 409);
    const rows = await orderedItems(env, survey.id, kind, id);
    if (!rows) return json({ error: "השיר לא נמצא." }, 404);
    const ordered = shiftIds(rows.map((row) => row.id), id, direction);
    if (!ordered) return json({ error: "אי אפשר להזיז את הפריט בכיוון הזה." }, 400);
    await saveOrder(env, kind, ordered);
    return json({ ok: true, message: direction < 0 ? "הפריט הוזז למעלה." : "הפריט הוזז למטה." });
  }

  if (body.action === "reset-votes") {
    const settings = await readSettings(env, survey.id);
    if (settings.votingOpen) return json({ error: "כדי לאפס הצבעות יש לסגור קודם את ההצבעה." }, 409);
    const deleted = await resetPollVotes(env, survey.id);
    return json({ ok: true, message: `${deleted} הצבעות נמחקו.` });
  }

  if (body.action === "create-archive") {
    let archive;
    try { archive = await createPollSnapshot(env, "ארכיון שנוצר דרך הטלפון", survey.id); }
    catch (error) { console.error("phone archive failed", error); return json({ error: "הגיבוי בוטל כי אחד מקובצי המדיה חסר." }, 500); }
    return json({ ok: true, message: "נוצר גיבוי מלא של הסקר בארכיון.", archive: { key: archive.key, name: archive.name } });
  }

  if (body.action === "restore-archive") {
    const key = String(body.key || "");
    const settings = await readSettings(env, survey.id);
    if (settings.votingOpen) return json({ error: "כדי לשחזר ארכיון יש לסגור קודם את ההצבעה." }, 409);
    try { await restorePollArchive(env, key, survey.id); }
    catch (error) { console.error("phone archive restore failed", error); return json({ error: "שחזור הארכיון נכשל והמצב הקודם נשמר." }, 500); }
    return json({ ok: true, message: "הארכיון שוחזר כטיוטה." });
  }

  if (body.action === "delete-archive") {
    const key = String(body.key || "");
    if (!key.startsWith("poll-archives/") || !key.endsWith(".json")) return json({ error: "הארכיון אינו תקין." }, 400);
    await deletePollArchive(env, key);
    return json({ ok: true, message: "הארכיון נמחק." });
  }

  if (body.action === "delete-prompt") {
    const key = String(body.key || "").trim();
    if (!/^[a-z0-9:_-]+$/i.test(key)) return json({ error: "סוג הקריינות אינו תקין." }, 400);
    const prompts = await readIvrPrompts(env);
    const current = prompts.find((prompt) => prompt.key === key);
    if (!current) return json({ error: "אין קריינות מוקלטת למחיקה." }, 404);
    await deleteIvrPrompt(env, key);
    await deleteIvrAudioIfUnreferenced(env, current.audioUrl);
    return json({ ok: true, message: "הקריינות נמחקה והקו יחזור לקריינות האוטומטית." });
  }

  if (body.action === "create-item") {
    const kind = body.kind;
    if (!kind) return json({ error: "סוג הפריט אינו תקין." }, 400);
    const settings = await readSettings(env, survey.id);
    if (settings.votingOpen) return json({ error: "כדי להוסיף פריט יש לסגור קודם את ההצבעה." }, 409);
    const id = crypto.randomUUID();
    if (kind === "album") {
      const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM albums WHERE survey_id=?").bind(survey.id).first<{ total: number }>();
      const title = `אלבום ${Number(total?.total || 0) + 1}`;
      const position = Number((await env.DB.prepare("SELECT COALESCE(MAX(position),-1)+1 AS position FROM albums WHERE survey_id=?").bind(survey.id).first<{ position: number }>())?.position || 0);
      await env.DB.prepare("INSERT INTO albums (id,survey_id,title,artist_name,position,active) VALUES (?,?,?,?,?,0)").bind(id, survey.id, title, "טרם עודכן", position).run();
      return json({ ok: true, id, title, promptKey: `album:${id}`, message: `${title} נוסף כמושבת. הקליטו את שמו והפעילו אותו.` });
    }
    if (kind === "artist") {
      const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM artists WHERE survey_id=?").bind(survey.id).first<{ total: number }>();
      const title = `זמר ${Number(total?.total || 0) + 1}`;
      const position = Number((await env.DB.prepare("SELECT COALESCE(MAX(position),-1)+1 AS position FROM artists WHERE survey_id=?").bind(survey.id).first<{ position: number }>())?.position || 0);
      await env.DB.prepare("INSERT INTO artists (id,survey_id,name,position,active) VALUES (?,?,?,?,0)").bind(id, survey.id, title, position).run();
      return json({ ok: true, id, title, promptKey: `artist:${id}`, message: `${title} נוסף כמושבת. הקליטו את שמו והפעילו אותו.` });
    }
    const albumId = String(body.albumId || "").trim();
    const album = albumId ? await env.DB.prepare("SELECT id,title FROM albums WHERE id=? AND survey_id=?").bind(albumId, survey.id).first<{ id: string; title: string }>() : null;
    if (!album) return json({ error: "האלבום לא נמצא בסקר הפעיל." }, 404);
    const total = await env.DB.prepare("SELECT COUNT(*) AS total FROM songs WHERE album_id=?").bind(albumId).first<{ total: number }>();
    const title = `שיר ${Number(total?.total || 0) + 1}`;
    const position = Number((await env.DB.prepare("SELECT COALESCE(MAX(position),-1)+1 AS position FROM songs WHERE album_id=?").bind(albumId).first<{ position: number }>())?.position || 0);
    await env.DB.prepare("INSERT INTO songs (id,album_id,title,position,active) VALUES (?,?,?,?,0)").bind(id, albumId, title, position).run();
    return json({ ok: true, id, title, promptKey: `song:${id}`, message: `${title} נוסף לאלבום ${album.title} כמושבת. הקליטו את שמו והפעילו אותו.` });
  }

  if (body.action === "set-position") {
    const kind = body.kind, id = String(body.id || "").trim(), position = Number(body.position);
    if (!kind || !id || !Number.isInteger(position) || position < 1) return json({ error: "הפריט או המקום אינם תקינים." }, 400);
    const settings = await readSettings(env, survey.id);
    if (settings.votingOpen) return json({ error: "כדי לשנות סדר יש לסגור קודם את ההצבעה." }, 409);
    const rows = await orderedItems(env, survey.id, kind, id);
    if (!rows) return json({ error: "הפריט לא נמצא בסקר הפעיל." }, 404);
    const ordered = reorderIds(rows.map((row) => row.id), id, position);
    if (!ordered) return json({ error: `אפשר לבחור מקום בין 1 ל ${rows.length}.` }, 400);
    await saveOrder(env, kind, ordered);
    return json({ ok: true, message: `הפריט הועבר למקום ${position}.` });
  }

  if (body.action === "set-preview" || body.action === "suggest-preview") {
    const id = String(body.id || "").trim();
    const song = id ? await env.DB.prepare("SELECT s.id,s.title,s.audio_url AS audioUrl FROM songs s JOIN albums a ON a.id=s.album_id WHERE s.id=? AND a.survey_id=?").bind(id, survey.id).first<{ id: string; title: string; audioUrl?: string }>() : null;
    if (!song) return json({ error: "השיר לא נמצא בסקר הפעיל." }, 404);
    let start = Number(body.start), end = Number(body.end);
    if (body.action === "suggest-preview") {
      if (!song.audioUrl) return json({ error: "לשיר אין קובץ שמע לניתוח." }, 400);
      try { ({ start, end } = await suggestChorusAI(env, song.audioUrl)); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "ניתוח הפזמון נכשל." }, 502); }
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return json({ error: "זמני הקטע אינם תקינים." }, 400);
    await env.DB.prepare("UPDATE songs SET preview_start=?,preview_end=? WHERE id=?").bind(start, end, id).run();
    return json({ ok: true, start, end, message: `קטע ההשמעה של ${song.title} מתחיל בשנייה ${start} ומסתיים בשנייה ${end}.` });
  }

  if (body.action === "generate-tts") {
    const key = String(body.key || "").trim();
    if (!/^[a-z0-9:_-]+$/i.test(key)) return json({ error: "סוג הקריינות אינו תקין." }, 400);
    if (!ttsConfigured(env)) return json({ error: "שירות הקריינות האוטומטית אינו מוגדר." }, 503);
    const label = String(body.label || "").trim() || await promptLabel(env, survey.id, key);
    if (!label) return json({ error: "לא נמצא טקסט לקריינות." }, 404);
    try { await saveTtsPrompt(env, key, label); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "יצירת הקריינות נכשלה." }, 502); }
    return json({ ok: true, message: "נוצרה קריינות אוטומטית והיא פעילה בקו." });
  }

  if (body.action === "generate-missing-tts") {
    if (!ttsConfigured(env)) return json({ error: "שירות הקריינות האוטומטית אינו מוגדר." }, 503);
    const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 20);
    const existing = new Set((await readIvrPrompts(env)).map((prompt) => prompt.key));
    const [albums, artists, songs] = await env.DB.batch<{ id: string; label: string }>([
      env.DB.prepare("SELECT id,title AS label FROM albums WHERE survey_id=? ORDER BY position,title").bind(survey.id),
      env.DB.prepare("SELECT id,name AS label FROM artists WHERE survey_id=? ORDER BY position,name").bind(survey.id),
      env.DB.prepare("SELECT s.id,s.title AS label FROM songs s JOIN albums a ON a.id=s.album_id WHERE a.survey_id=? ORDER BY s.album_id,s.position,s.title").bind(survey.id),
    ]);
    const pending = [
      ...albums.results.map((row) => ({ key: `album:${row.id}`, label: String(row.label) })),
      ...artists.results.map((row) => ({ key: `artist:${row.id}`, label: String(row.label) })),
      ...songs.results.map((row) => ({ key: `song:${row.id}`, label: String(row.label) })),
    ].filter((item) => !existing.has(item.key));
    let created = 0;
    for (const item of pending.slice(0, limit)) {
      try { await saveTtsPrompt(env, item.key, item.label); created++; }
      catch (error) { console.error("phone tts generation failed", item.key, error); break; }
    }
    const remaining = Math.max(pending.length - created, 0);
    return json({ ok: true, created, remaining, message: remaining ? `נוצרו ${created} קריינויות, נשארו ${remaining}.` : `נוצרו ${created} קריינויות. לכל הפריטים יש קריינות.` });
  }

  if (body.action === "extract-covers") {
    const result = await extractSurveyCovers(env, survey.id);
    return json({ ok: true, ...result, message: `נבדקו ${result.total} שירים ונשמרו ${result.extracted} עטיפות.` });
  }

  if (body.action === "remove-manager") {
    const email = String(body.email || "").trim().toLowerCase();
    const managers = await readAdminEmails(env);
    if (!email || !managers.includes(email)) return json({ error: "מנהל האתר לא נמצא ברשימה." }, 404);
    if (managers.length <= 1) return json({ error: "אי אפשר להסיר את מנהל האתר האחרון." }, 400);
    const next = await saveAdminEmails(env, managers.filter((item) => item !== email));
    return json({ ok: true, managers: next, message: "ההרשאה של מנהל האתר הוסרה." });
  }

  return json({ error: "פעולת הניהול אינה מוכרת." }, 400);
}

export async function ivrAdminApi(request: Request, env: IvrAdminEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/ivr/admin/overview") {
    return overview(env, url.searchParams.get("phone") || "");
  }
  if (request.method === "POST" && url.pathname === "/api/ivr/admin/action") {
    let body: ActionBody;
    try { body = await request.json<ActionBody>(); }
    catch { return json({ error: "בקשת הניהול אינה תקינה." }, 400); }
    const response = await action(env, body);
    try {
      const target = body.targetPhone || body.id || body.key || body.stage || body.kind || null;
      await env.DB.prepare("INSERT INTO ivr_admin_audit (id,phone,action,target,status) VALUES (?,?,?,?,?)")
        .bind(crypto.randomUUID(), normalizePhone(body.phone || "") || "unknown", String(body.action || "unknown"), target, response.status).run();
    } catch (error) { console.error("phone admin audit failed", error); }
    return response;
  }
  return json({ error: "הפעולה לא נמצאה." }, 404);
}
