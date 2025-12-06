// Common text helpers for simplifying and formatting output

function cleanSimplifiedText(text) {
  return (text || "")
    // Αφαίρεση markdown links [κείμενο](url)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, "$1")
    // Αφαίρεση σκέτων URLs
    .replace(/https?:\/\/\S+/g, "")
    // Καθάρισμα πολλών κενών
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function extractSourceDomains(urls) {
  if (!Array.isArray(urls)) return [];

  const domains = urls
    .map((u) => {
      try {
        const hostname = new URL(u).hostname || "";
        return hostname.replace(/^www\./, "");
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return [...new Set(domains)];
}

function buildSourcesFooter(domains) {
  if (!domains || domains.length === 0) return "";

  if (domains.length === 1) {
    return `\n\nΠηγή: ${domains[0]}`;
  }

  return `\n\nΠηγές: ${domains.join(", ")}`;
}

function getWebSearchDateContext(baseDate = new Date()) {
  const today = new Date(baseDate);
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const formatter = new Intl.DateTimeFormat("el-GR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return {
    today,
    yesterday,
    tomorrow,
    todayLabel: formatter.format(today),
    yesterdayLabel: formatter.format(yesterday),
    tomorrowLabel: formatter.format(tomorrow),
  };
}

function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[«»"“”']/g, "")
    .trim();
}

function dedupeArticlesByUrlOrTitle(articles) {
  const seenUrls = new Set();
  const seenTitles = new Set();

  const result = [];

  for (const art of articles) {
    const url = (art.url || art.link || art.sourceUrl || "").trim();
    const normTitle = normalizeTitle(art.title || "");

    const urlKey = url.toLowerCase();
    const titleKey = normTitle;

    const isDuplicateByUrl = urlKey && seenUrls.has(urlKey);
    const isDuplicateByTitle = titleKey && seenTitles.has(titleKey);

    if (isDuplicateByUrl || isDuplicateByTitle) {
      continue;
    }

    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenTitles.add(titleKey);

    result.push(art);
  }

  return result;
}

export {
  cleanSimplifiedText,
  extractSourceDomains,
  buildSourcesFooter,
  getWebSearchDateContext,
  normalizeTitle,
  dedupeArticlesByUrlOrTitle,
};
