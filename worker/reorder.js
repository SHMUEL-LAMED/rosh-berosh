/** סידור מחדש של רשימת מזהים, משותף להזזה בכיוון ולהעברה למקום מסוים. */

export function shiftIds(ids, id, direction) {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || !direction || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function reorderIds(ids, id, position) {
  const index = ids.indexOf(id);
  if (index < 0 || !Number.isInteger(position) || position < 1 || position > ids.length) return null;
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  next.splice(position - 1, 0, moved);
  return next;
}
