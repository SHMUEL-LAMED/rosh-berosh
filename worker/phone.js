/**
 * Convert the phone formats Yemot commonly sends into one canonical Israeli
 * number. Invalid, withheld, and non-phone identifiers become an empty string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00972")) digits = digits.slice(2);
  if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  if (/^5\d{8}$/.test(digits)) digits = `0${digits}`;
  return /^0\d{8,9}$/.test(digits) ? digits : "";
}
