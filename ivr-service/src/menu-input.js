const PAGE_SIZE = 8;

function menuReadOptions(digits) {
  return {
    min_digits: 1,
    max_digits: 1,
    digits_allowed: digits,
    typing_playback_mode: "No",
  };
}

function menuPages(items) {
  if (items.length <= 9) return items.length ? [items] : [];
  const pages = [];
  for (let index = 0; index < items.length; index += PAGE_SIZE) pages.push(items.slice(index, index + PAGE_SIZE));
  return pages;
}

function pagePromptKey(baseKey, pageIndex, pageCount) {
  return pageCount > 1 ? `${baseKey}:page:${pageIndex + 1}` : baseKey;
}

module.exports = { PAGE_SIZE, menuPages, menuReadOptions, pagePromptKey };
