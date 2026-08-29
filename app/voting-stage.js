export function hasStageChoices(stage, catalog, selectedAlbumCount = 0) {
  if (!catalog) return false;
  if (stage === "summary") return true;
  if (stage === "albums") return Array.isArray(catalog.albums) && catalog.albums.length > 0;
  if (stage === "artists") return Array.isArray(catalog.artists) && catalog.artists.length > 0;
  if (stage === "songs") return selectedAlbumCount > 0;
  return false;
}
