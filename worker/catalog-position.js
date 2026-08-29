export function resolveCatalogPosition(value, existingPosition, appendPosition) {
  if (value !== undefined && value !== null && String(value).trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (existingPosition !== undefined && existingPosition !== null && Number.isFinite(Number(existingPosition))) return Number(existingPosition);
  return Number.isFinite(Number(appendPosition)) ? Number(appendPosition) : 0;
}
