/** עוזרי SQL משותפים לוורקר. */

/** רשימת סימני שאלה לשאילתת `IN (...)`, כדי שערכים יעברו תמיד כפרמטרים. */
export function placeholders(count) {
  return Array(count).fill("?").join(",");
}
