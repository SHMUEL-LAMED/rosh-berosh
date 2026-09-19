function uniqueStrings(value) {
  return [...new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : [])];
}

function sanitizeProgress(saved, catalog, rules) {
  const source = saved && typeof saved === "object" ? saved : {};
  const albums = Array.isArray(catalog?.albums) ? catalog.albums : [];
  const songs = Array.isArray(catalog?.songs) ? catalog.songs : [];
  const artists = Array.isArray(catalog?.artists) ? catalog.artists : [];
  const albumIds = rules?.albumsEnabled
    ? uniqueStrings(source.albumIds).filter((id) => albums.some((album) => album.id === id)).slice(0, Math.max(0, Number(rules.albumsMax) || 0))
    : [];
  const songIdsByAlbum = {};
  if (rules?.songsEnabled) {
    for (const albumId of albumIds) {
      const valid = new Set(songs.filter((song) => song.albumId === albumId).map((song) => song.id));
      songIdsByAlbum[albumId] = uniqueStrings(source.songIdsByAlbum?.[albumId]).filter((id) => valid.has(id)).slice(0, Math.max(0, Number(rules.songsMax) || 0));
    }
  }
  const artistIds = rules?.artistsEnabled
    ? uniqueStrings(source.artistIds).filter((id) => artists.some((artist) => artist.id === id)).slice(0, Math.max(0, Number(rules.artistsMax) || 0))
    : [];
  return { albumIds, songIdsByAlbum, artistIds };
}

function progressChanged(saved, sanitized) {
  const original = saved && typeof saved === "object" ? {
    albumIds: uniqueStrings(saved.albumIds),
    songIdsByAlbum: saved.songIdsByAlbum && typeof saved.songIdsByAlbum === "object" ? saved.songIdsByAlbum : {},
    artistIds: uniqueStrings(saved.artistIds),
  } : { albumIds: [], songIdsByAlbum: {}, artistIds: [] };
  return JSON.stringify(original) !== JSON.stringify(sanitized);
}

// זמני ההצבעה בקו: תחילת השיחה הראשונה, סיום כל שלב בפעם הראשונה ומספר
// השיחות. נשמרים לצד הבחירות ונשלחים עם הפתק, כמו שהאתר עושה.
function restoreTiming(saved, now = Math.floor(Date.now() / 1000)) {
  const source = saved && saved.timing && typeof saved.timing === "object" ? saved.timing : {};
  const startedAt = Number(source.startedAt) > 0 ? Math.floor(Number(source.startedAt)) : now;
  const stamp = (value) => (Number(value) >= startedAt ? Math.floor(Number(value)) : undefined);
  const sessions = (Number(source.sessions) > 0 ? Math.floor(Number(source.sessions)) : 0) + 1;
  return { startedAt, albumsDoneAt: stamp(source.albumsDoneAt), songsDoneAt: stamp(source.songsDoneAt), artistsDoneAt: stamp(source.artistsDoneAt), sessions };
}

function markStageDone(timing, key, now = Math.floor(Date.now() / 1000)) {
  if (!timing || timing[key]) return timing;
  return { ...timing, [key]: now };
}

module.exports = { sanitizeProgress, progressChanged, restoreTiming, markStageDone };
