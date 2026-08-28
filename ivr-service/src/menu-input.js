const PAGE_SIZE = 8;

function menuReadOptions(digits) {
  return {
    min_digits: 1,
    max_digits: 1,
    digits_allowed: digits,
    typing_playback_mode: "No",
  };
}

function menuCodeWidth(itemCount) {
  return itemCount > 9 ? String(itemCount).length : 1;
}

function menuCode(index, width) {
  return String(index + 1).padStart(width, "0");
}

function continuousMenuInput(itemCount, allowFinish = false) {
  const width = menuCodeWidth(itemCount);
  const finishCode = "0".repeat(width);
  const digitsAllowed = Array.from({ length: itemCount }, (_, index) => menuCode(index, width));
  if (allowFinish) digitsAllowed.unshift(finishCode);
  return {
    width,
    finishCode,
    read: {
      min_digits: width,
      max_digits: width,
      digits_allowed: digitsAllowed,
      typing_playback_mode: "No",
    },
  };
}

function menuPages(items) {
  if (items.length <= 9) return items.length ? [items] : [];
  const pages = [];
  for (let index = 0; index < items.length; index += PAGE_SIZE) pages.push(items.slice(index, index + PAGE_SIZE));
  return pages;
}

module.exports = { PAGE_SIZE, continuousMenuInput, menuCode, menuCodeWidth, menuPages, menuReadOptions };
