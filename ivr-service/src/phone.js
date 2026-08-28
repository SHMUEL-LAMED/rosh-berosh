function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00972")) digits = digits.slice(2);
  if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  if (/^5\d{8}$/.test(digits)) digits = `0${digits}`;
  return /^0\d{8,9}$/.test(digits) ? digits : "";
}

function phone(call) {
  return normalizePhone(call?.phone || call?.ApiPhone || call?.values?.ApiPhone || call?.values?.Phone);
}

module.exports = { normalizePhone, phone };
