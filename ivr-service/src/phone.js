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

// ברירת המחדל של היעד בסיום השיחה בקו ההצבעה: המתקשר מועבר חזרה לקו הראשי,
// גם אחרי הצבעה שנקלטה עכשיו וגם אחרי הודעת "כבר הצבעתם" למי שהצביע כבר.
const DEFAULT_POST_VOTE_TRANSFER = "0796077075";

// POST_VOTE_TRANSFER דורס את המספר, והערך "off" מבטל את ההעברה לגמרי ומחזיר
// את הקו לסיום שיחה רגיל. "0" נחשב ביטול ולא יעד, כי אין שלוחה כזאת.
function resolvePostVoteTransfer(value) {
  const setting = String(value ?? "").trim();
  if (/^(0|off|none|no)$/i.test(setting)) return "";
  return (setting || DEFAULT_POST_VOTE_TRANSFER).replace(/\D/g, "");
}

module.exports = { DEFAULT_POST_VOTE_TRANSFER, normalizePhone, phone, resolvePostVoteTransfer };
