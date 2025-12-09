import fs from "fs/promises";
import Parser from "rss-parser";
import crypto from "crypto";
import { CATEGORY_KEYS } from "./llm/newsCategories.js";
import { simplifyNewsArticle } from "./llm/newsSimplifier.js";
import { classifyNewsArticle } from "./llm/newsCategorizer.js";
import { openai } from "./llm/openaiClient.js";
import { WEB_SEARCH_NEWS_INSTRUCTIONS } from "./newsLlmInstructions.js";
import {
  buildSourcesFooter,
  cleanSimplifiedText,
  extractSourceDomains,
  getWebSearchDateContext,
  dedupeArticlesByUrlOrTitle,
  extractWebSearchSources,
} from "./llm/textUtils.js";

export { CATEGORY_KEYS };

// Generic Pixabay queries per category (fallback if feeds don't provide images)
const CATEGORY_IMAGE_QUERIES = {
  serious: "breaking news newspaper city",
  sports: "sports football soccer stadium",
  screen: "cinema movie theater screen",
  culture: "concert stage music band",
  fun: "friends fun night city",
  happy: "happy people sunshine",
  other: "news abstract background",
};

let hasWarnedMissingPixabayKey = false;

async function fetchPixabayImageForCategory(categoryKey) {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) {
    if (!hasWarnedMissingPixabayKey) {
      console.warn("⚠️ PIXABAY_API_KEY is not set. Skipping images.");
      hasWarnedMissingPixabayKey = true;
    }
    return null;
  }

  const baseQuery = CATEGORY_IMAGE_QUERIES[categoryKey] || "news abstract background";

  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", baseQuery);
  url.searchParams.set("image_type", "photo");
  url.searchParams.set("orientation", "horizontal");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", "5");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.warn("Pixabay API error", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const hit = data.hits?.[0];
    if (!hit) return null;

    return hit.webformatURL || hit.previewURL || null;
  } catch (err) {
    console.error("Pixabay fetch failed", err);
    return null;
  }
}

const TARGET_CATEGORIES = CATEGORY_KEYS.filter((key) => key !== "other");

const MIN_ARTICLES_PER_CATEGORY = 2;
const MAX_ARTICLES_PER_CATEGORY = 6;

// 👉 Θα γράφουμε το news.json δίπλα στο αρχείο αυτό
const NEWS_JSON_PATH = new URL("./news.json", import.meta.url);

// RSS feeds που θα διαβάζουμε
// ⚠️ Πολλά από τα παρακάτω sites περιορίζουν τη χρήση (συχνά «μόνο για προσωπική χρήση»).
// Εδώ τα βάζουμε τεχνικά για να δουλεύει το pipeline· για δημόσια/εμπορική χρήση
// είναι καλό να έχεις ρητή άδεια από τα μέσα.
const FEEDS = [
  // Δημόσιος ραδιοτηλεοπτικός φορέας
  {
    url: "https://www.ertnews.gr/feed",
    sourceName: "ERT News",
  },

  // 🔹 Μεγάλες εφημερίδες / portals
  {
    url: "https://www.tanea.gr/feed",
    sourceName: "TA NEA",
  },
  {
    // Όλα τα νέα από ΤΟ ΒΗΜΑ
    url: "https://www.tovima.gr/feed",
    // Εναλλακτικά (αν θες πιο «γεμάτο» feed): "https://www.tovima.gr/feed/allnews/"
    sourceName: "TO BHMA",
  },
  {
    // Γενική ροή του news.gr
    url: "https://www.news.gr/rss.ashx",
    sourceName: "News.gr",
  },
  {
    url: "https://www.902.gr/feed/featured",
    sourceName: "902.gr – Επιλεγμένα",
  },
  {
    url: "https://www.newsbomb.gr/oles-oi-eidhseis?format=feed&type=rss",
    sourceName: "Newsbomb.gr",
  },
  {
    url: "https://www.protagon.gr/feed",
    sourceName: "Protagon",
  },

  // 🔹 Αγγλόφωνη κάλυψη για Ελλάδα
  {
    url: "https://greekreporter.com/greece/feed",
    sourceName: "Greek Reporter – Greece",
  },

  // 🔹 Χαρούμενες ειδήσεις
  {
    url: "https://thehappynews.gr/feed/",
    sourceName: "The Happy News",
    categoryHints: ["happy"],
  },

  // Αν θέλεις αργότερα μπορείς να προσθέσεις κι άλλα:
  // { url: "https://topontiki.gr/rss", sourceName: "Το Ποντίκι" },
  // { url: "https://dimokratiki.gr/feed", sourceName: "Δημοκρατική Ρόδου" },
];

// 🔹 Πηγές με πιο "ελαστικό" copyright (open data)
// Δεν τις καλούμε ακόμη, απλά τις δηλώνουμε για μελλοντική χρήση.
const OPEN_DATA_SOURCES = {
  moviesAndSeries: "TMDB",
  music: "MusicBrainz",
  cultureGR: "SearchCulture.gr",
  cultureEU: "Europeana",
};

// Ρυθμίζουμε το parser να κρατά και extra πεδία για εικόνες/HTML
const parser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
    ],
  },
});

function extractTextFromResponse(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const first = response.output?.[0]?.content?.[0]?.text;
  if (typeof first === "string") return first;
  if (first?.text) return first.text;
  if (first?.value) return first.value;

  throw new Error("Δεν βρέθηκε text στο response του μοντέλου");
}

// Πολύ απλό καθάρισμα HTML -> απλό κείμενο
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Σταθερό id άρθρου με βάση guid/link κτλ. (για raw άρθρα ανά feed)
function makeArticleId(feedUrl, item) {
  const base =
    item.guid ||
    item.id ||
    item.link ||
    `${feedUrl}:${item.title || ""}:${item.pubDate || ""}`;

  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 12);
}

// Προσπαθούμε να βρούμε μια εικόνα από το item ή το HTML
function extractImageUrl(item, html = "") {
  // 1) mediaContent (Media RSS)
  if (Array.isArray(item.mediaContent)) {
    for (const m of item.mediaContent) {
      const url = m?.$?.url || m?.url;
      const medium = (m?.$?.medium || "").toLowerCase();
      const type = m?.$?.type || "";
      if (
        url &&
        (medium === "image" || (type && type.startsWith("image/")))
      ) {
        return url;
      }
    }
  }

  // 2) mediaThumbnail
  if (Array.isArray(item.mediaThumbnail)) {
    for (const t of item.mediaThumbnail) {
      const url = t?.$?.url || t?.url;
      if (url) return url;
    }
  }

  // 3) enclosure με τύπο εικόνας
  const enclosure = item.enclosure;
  if (enclosure && enclosure.url && /^image\//.test(enclosure.type || "")) {
    return enclosure.url;
  }

  // 4) Πρώτο <img ... src="..."> μέσα στο HTML (αν υπάρχει)
  if (html) {
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];
  }

  return null;
}

// Προσπαθούμε να βρούμε video url
function extractVideoUrl(item, html = "") {
  const enclosure = item.enclosure;
  if (enclosure && enclosure.url && /^video\//.test(enclosure.type || "")) {
    return enclosure.url;
  }

  if (html) {
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (iframeMatch) return iframeMatch[1];

    const videoMatch = html.match(/<video[^>]+src=["']([^"']+)["']/i);
    if (videoMatch) return videoMatch[1];
  }

  return null;
}

// 🚩 Κανονικοποίηση κατηγορίας από το LLM
function normalizeCategory(rawCategory) {
  if (!rawCategory) return "fun";
  const c = rawCategory.toString().toLowerCase().trim();

  // Σοβαρές ειδήσεις
  if (
    [
      "serious",
      "serious_news",
      "σοβαρες ειδησεις",
      "σοβαρές ειδήσεις",
      "politics",
      "economy",
      "πολιτικη",
      "πολιτική",
      "οικονομια",
      "οικονομία",
    ].includes(c)
  ) {
    return "serious";
  }

  // Χαρούμενες ειδήσεις
  if (
    [
      "happy",
      "goodnews",
      "good news",
      "positive",
      "feelgood",
      "χαρουμενες",
      "χαρούμενες",
      "χαρουμενες ειδησεις",
      "χαρούμενες ειδήσεις",
      "θετικα νεα",
      "θετικά νέα",
      "καλες ειδησεις",
      "καλές ειδήσεις",
    ].includes(c)
  ) {
    return "happy";
  }

  // Αθλητισμός
  if (["sports", "sport", "αθλητισμος", "αθλητισμός"].includes(c)) {
    return "sports";
  }

  // Τηλεόραση και σινεμά
  if (
    [
      "movies",
      "movie",
      "ταινιες",
      "ταινίες",
      "cinema",
      "σινεμα",
      "σινεμά",
      "series",
      "σειρες",
      "σειρές",
      "tv",
      "τηλεοραση",
      "τηλεόραση",
    ].includes(c)
  ) {
    return "screen";
  }

  // Πολιτισμός (μουσική + θέατρο)
  if (
    [
      "music",
      "μουσικη",
      "μουσική",
      "theatre",
      "theater",
      "θεατρο",
      "θέατρο",
      "culture",
      "πολιτισμος",
      "πολιτισμός",
    ].includes(c)
  ) {
    return "culture";
  }

  // Διασκέδαση (fun)
  if (
    [
      "fun",
      "entertainment",
      "διασκεδαση",
      "διασκέδαση",
      "ψυχαγωγια",
      "ψυχαγωγία",
      "nightlife",
      "bars",
      "εξοδοι",
      "έξοδοι",
    ].includes(c)
  ) {
    return "fun";
  }

  return "fun"; // ασφαλής προεπιλογή εντός επιτρεπόμενων κατηγοριών
}

function searchQueriesForCategory(category) {
  switch (category) {
    case "happy":
      return [
        "ευχάριστες ειδήσεις καλά νέα Ελλάδα",
        "θετικές ανθρώπινες ιστορίες Ελλάδα",
        "χαρούμενες ειδήσεις σήμερα",
      ];
    case "serious":
      return [
        "σημαντικές ειδήσεις Ελλάδα σήμερα",
        "πολιτική οικονομία τελευταία νέα",
      ];
    case "sports":
      return ["αθλητικά νέα σήμερα Ελλάδα", "αποτελέσματα αγώνων Ελλάδα"];
    case "screen":
      return [
        "ταινίες πρεμιέρες Ελλάδα",
        "νέες σειρές τηλεόραση streaming Ελλάδα",
        "φεστιβάλ κινηματογράφου Ελλάδα",
      ];
    case "culture":
      return [
        "συναυλίες Ελλάδα σήμερα",
        "θεατρικές παραστάσεις Αθήνα σήμερα",
        "πολιτιστικές εκδηλώσεις φεστιβάλ Ελλάδα",
      ];
    case "fun":
      return ["εκδηλώσεις διασκέδαση Ελλάδα", "φεστιβάλ σήμερα Ελλάδα"];
    default:
      return ["σημερινές ειδήσεις Ελλάδα", "τελευταία νέα Ελλάδα"];
  }
}

async function generateWebSearchArticleForCategory(categoryKey) {
  const dateCtx = getWebSearchDateContext();
  const queries = searchQueriesForCategory(categoryKey);

  const userContent = `


Κατηγορία: ${categoryKey}
Ημερομηνία αναφοράς: ${dateCtx.todayLabel}
Χθες: ${dateCtx.yesterdayLabel}
Αύριο: ${dateCtx.tomorrowLabel}

Θέλω:

- Να χρησιμοποιήσεις ΜΟΝΟ web search (εργαλείο web_search_preview) για να βρεις ΕΝΑ πρόσφατο γεγονός που ταιριάζει στην κατηγορία "${categoryKey}".
- Να γράψεις ένα σύντομο κείμενο σε πολύ απλά ελληνικά, σύμφωνα με τις οδηγίες του system prompt.
- Να προτιμήσεις γεγονός από χθες/σήμερα/αύριο.

Προτεινόμενες αναζητήσεις:
${queries.map((q) => `- ${q}`).join("\n")}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1",
    instructions: WEB_SEARCH_NEWS_INSTRUCTIONS,
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
    input: userContent,
    max_output_tokens: 1200,
  });

  const rawText = extractTextFromResponse(response).trim();
  const cleaned = cleanSimplifiedText(rawText);

  const webSources = extractWebSearchSources(response);
  let sourceDomains = extractSourceDomains(
    webSources.map((s) => s.url).filter(Boolean)
  );

  if (!sourceDomains.length) {
    sourceDomains = ["web.search"];
  }

  const firstLine =
    cleaned.split(/\n+/).find((line) => line.trim()) ||
    `Είδηση κατηγορίας ${categoryKey}`;

  const simpleTitle = firstLine.replace(/\*+/g, "").trim().slice(0, 160);
  const footer = buildSourcesFooter(sourceDomains);
  const simpleText = cleaned + footer;

  const mainSourceName = webSources[0]?.title || "web.search";
  const mainSourceUrl = webSources[0]?.url || "";

  return {
    id: crypto.randomUUID(),
    title: simpleTitle,
    simpleTitle,
    simpleText,
    sourceName: mainSourceName,
    sourceUrl: mainSourceUrl,
    sources: webSources,
    sourceDomains,
    category: categoryKey,
    categoryReason: "web_search_fallback",
    isSensitive: false,
    imageUrl: null,
    videoUrl: null,
    publishedAt: dateCtx.today.toISOString(),
  };
}

// 🧠 Ομαλοποίηση τίτλου για ομαδοποίηση σε "θέματα"
function normalizeTitleForGrouping(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    // πετάμε εισαγωγικά, σημεία στίξης κλπ.
    .replace(/[«»"“”'’.,!?;:()[\]]+/g, " ")
    // πετάμε κοινές ετικέτες τύπου "live"
    .replace(/\blive\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ⚙️ Ρυθμίσεις για πιο "χαλαρή" ομαδοποίηση τίτλων
const TITLE_SIMILARITY_THRESHOLD = 0.35;

const TITLE_STOPWORDS = new Set([
  "στην",
  "στον",
  "στη",
  "στο",
  "για",
  "και",
  "με",
  "κατά",
  "κατα",
  "από",
  "απο",
  "επί",
  "εις",
  "των",
  "στοιχεία",
  "έκτακτο",
  "εκτακτο",
  "ειδηση",
  "είδηση",
  "ειδήσεις",
  "νεα",
  "νέα",
  "σημερα",
  "σήμερα",
]);

// Κλήση στο AI για απλοποίηση + κατηγοριοποίηση + παραφρασμένο τίτλο
// Χρησιμοποιεί τα νέα, κοινά helpers simplifyNewsArticle και classifyNewsArticle
// και τροφοδοτεί το LLM με όλα τα άρθρα της ίδιας θεματικής.
async function simplifyAndClassifyText(topicGroup) {
  const { articles } = topicGroup;
  if (!articles || articles.length === 0) {
    return null;
  }

  const parts = [];
  parts.push(
    "Παρακάτω είναι πληροφορίες για ΜΙΑ είδηση από ΕΝΑ ή ΠΕΡΙΣΣΟΤΕΡΑ άρθρα.\n" +
      "Όλα μιλούν για το ίδιο γεγονός. Χρησιμοποίησε τα όλα μαζί σαν υλικό."
  );

  articles.forEach((article, index) => {
    const src = article.sourceName || "Άγνωστη πηγή";
    const truncatedText = article.rawText.slice(0, 4000); // όριο ανά άρθρο
    parts.push(
      `\n\nΆρθρο ${index + 1}:\n` +
        `Πηγή: ${src}\n` +
        `Τίτλος: ${article.title}\n` +
        `Κείμενο:\n${truncatedText}\n`
    );
  });

  const combinedRawText = parts.join("\n");
  const baseTitle = topicGroup.title || articles[0]?.title || "Είδηση";
  const primarySourceUrl = articles[0]?.sourceUrl;

  const simplifiedText = await simplifyNewsArticle({
    title: baseTitle,
    rawText: combinedRawText,
    sourceUrl: primarySourceUrl,
  });

  const { category, reason } = await classifyNewsArticle({
    title: baseTitle,
    simpleText: simplifiedText,
    rawText: combinedRawText,
  });

  const hintedCategory =
    (topicGroup.categoryHints || []).find((c) => c && c !== "other") || null;
  const normalizedClassified = normalizeCategory(category);
  const finalCategory =
    normalizedClassified !== "other" ? normalizedClassified : hintedCategory || "other";

  const categoryReason =
    normalizedClassified !== "other"
      ? reason || ""
      : hintedCategory
      ? `${reason || "Κατηγορία από hints feed"} (hint: ${hintedCategory})`
      : reason || "";

  return {
    simplifiedText,
    simplifiedTitle: baseTitle,
    rawCategory: category,
    normalizedCategory: finalCategory,
    categoryReason,
    isSensitive: false,
  };
}

// helper: είναι η είδηση μέσα στο τελευταίο 24ωρο;
function isWithinLast24Hours(date, now = new Date()) {
  const diffMs = now.getTime() - date.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  return diffMs >= 0 && diffMs <= oneDayMs;
}

// 💡 επιλέγουμε μέχρι MAX_ARTICLES_PER_CATEGORY άρθρα ανά κατηγορία για "ειδήσεις της ημέρας"
function buildArticlesByCategory(allArticles) {
  const now = new Date();
  const fallbackCategory = CATEGORY_KEYS[0] || "serious";

  /** @type {Record<string, any[]>} */
  const byCategory = {};
  for (const key of CATEGORY_KEYS) {
    byCategory[key] = [];
  }

  for (const article of allArticles) {
    const cat = article.category || "other";
    const targetKey = byCategory[cat] ? cat : fallbackCategory;
    byCategory[targetKey].push(article);
  }

  const result = {};

  for (const key of CATEGORY_KEYS) {
    const items = byCategory[key] || [];

    // Ταξινόμηση από το πιο πρόσφατο στο πιο παλιό
    items.sort((a, b) => {
      const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return db - da;
    });

    // Πρώτα ειδήσεις τελευταίου 24ώρου
    const todayItems = items.filter((i) =>
      isWithinLast24Hours(new Date(i.publishedAt || now), now)
    );

    let selected = todayItems.slice(0, MAX_ARTICLES_PER_CATEGORY);

    // Αν δεν φτάνουν οι "τελείως σημερινές", συμπληρώνουμε από τις πιο παλιές
    if (selected.length < MAX_ARTICLES_PER_CATEGORY) {
      const remaining = items.filter((i) => !todayItems.includes(i));
      selected = selected.concat(
        remaining.slice(0, MAX_ARTICLES_PER_CATEGORY - selected.length)
      );
    }

    result[key] = selected;
  }

  return result;
}

async function backfillMissingCategories(allArticles) {
  for (const category of TARGET_CATEGORIES) {
    const current = allArticles.filter((a) => a.category === category);
    const missing = Math.max(0, MIN_ARTICLES_PER_CATEGORY - current.length);
    const availableSlots = Math.max(0, MAX_ARTICLES_PER_CATEGORY - current.length);
    const toGenerate = Math.min(missing, availableSlots);

    if (toGenerate > 0) {
      console.log(
        `ℹ️ Fallback web search για την κατηγορία ${category} (λείπουν ${missing} άρθρα).`
      );
    }

    for (let i = 0; i < toGenerate; i += 1) {
      try {
        const article = await generateWebSearchArticleForCategory(category);
        if (article) {
          allArticles.push(article);
        }
      } catch (err) {
        console.error(`❌ Αποτυχία web search fallback για ${category}:`, err);
      }
    }
  }
}

// 🧱 Ομαδοποίηση raw άρθρων σε "θέματα" με βάση ΟΜΟΙΟΤΗΤΑ τίτλου
function groupArticlesByTopic(rawArticles) {
  const groups = [];

  // Παίρνουμε σύνολο "σημαντικών" λέξεων από τον τίτλο
  function getTitleWordSet(title) {
    const norm = normalizeTitleForGrouping(title);
    if (!norm) return new Set();
    return new Set(
      norm
        .split(" ")
        .filter((w) => {
          const word = w.trim();
          if (word.length <= 3) return false;
          if (TITLE_STOPWORDS.has(word)) return false;
          return true;
        })
    );
  }

  // Υπολογισμός ομοιότητας δύο συνόλων λέξεων (Jaccard-like)
  function similarity(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const w of setA) {
      if (setB.has(w)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    if (union === 0) return 0;
    return intersection / union;
  }

  for (const article of rawArticles) {
    const titleWords = getTitleWordSet(article.title);
    let bestGroup = null;
    let bestScore = 0;

    // βρίσκουμε αν "κολλάει" καλύτερα σε κάποια υπάρχουσα ομάδα
    for (const group of groups) {
      const score = similarity(titleWords, group.titleWords);
      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    }

    // Κατώφλι ομοιότητας: αν μοιράζονται αρκετές λέξεις, τα θεωρούμε ίδιο θέμα
    if (bestGroup && bestScore >= TITLE_SIMILARITY_THRESHOLD) {
      bestGroup.articles.push(article);
      // ενημερώνουμε και το word set της ομάδας (ένωση)
      for (const w of titleWords) {
        bestGroup.titleWords.add(w);
      }
    } else {
      // Νέο θέμα
      groups.push({
        idSeed: article.id,
        title: article.title,
        titleWords,
        articles: [article],
      });
    }
  }

  // Τελική μετατροπή σε topicGroups, με id, εικόνα κλπ.
  const topicGroups = [];

  for (const group of groups) {
    const primary = group.articles[0];

    // publishedAt = πιο πρόσφατο από την ομάδα
    let latestPublishedAt = primary.publishedAt || null;
    for (const a of group.articles) {
      if (!a.publishedAt) continue;
      if (!latestPublishedAt || new Date(a.publishedAt) > new Date(latestPublishedAt)) {
        latestPublishedAt = a.publishedAt;
      }
    }

    const imageUrl =
      group.articles.find((a) => a.imageUrl)?.imageUrl || null;
    const videoUrl =
      group.articles.find((a) => a.videoUrl)?.videoUrl || null;

    // id θέματος: hash από όλα τα raw ids της ομάδας
    const groupId = crypto
      .createHash("sha1")
      .update(group.articles.map((a) => a.id).sort().join("-"))
      .digest("hex")
      .slice(0, 12);

    const hintSet = new Set();
    for (const a of group.articles) {
      if (Array.isArray(a.categoryHints)) {
        for (const h of a.categoryHints) {
          const normalized = normalizeCategory(h);
          if (normalized && normalized !== "other") {
            hintSet.add(normalized);
          }
        }
      }
    }

    const uniqueSources = new Set(
      group.articles
        .map((a) => a.sourceName || a.sourceUrl || "")
        .filter(Boolean)
        .map((s) => s.toLowerCase())
    );

    const totalSourcesCount = uniqueSources.size || 1;
    const isImportant = totalSourcesCount >= 2 || hintSet.size > 0;

    topicGroups.push({
      id: groupId,
      key: group.title,
      title: primary.title,
      articles: group.articles,
      imageUrl,
      videoUrl,
      publishedAt: latestPublishedAt,
      totalSourcesCount,
      isImportant,
      categoryHints: [...hintSet],
    });
  }

  return topicGroups;
}

async function run() {
  const rawArticles = [];

  // 1️⃣ Μαζεύουμε ΟΛΑ τα raw άρθρα από ΟΛΑ τα feeds
  for (const feed of FEEDS) {
    console.log("Διαβάζω feed:", feed.url);
    let rss;
    try {
      rss = await parser.parseURL(feed.url);
    } catch (err) {
      console.error("Σφάλμα στο feed", feed.url, err);
      continue;
    }

    const items = (rss.items || []).slice(0, 30); // παίρνουμε αρκετές για να έχουμε υλικό

    for (const item of items) {
      const title = item.title || "";
      const link = item.link || "";

      const htmlContent =
        item.contentEncoded ||
        item.content ||
        item.summary ||
        item.contentSnippet ||
        "";

      const rawText = stripHtml(htmlContent);
      if (!rawText) continue;

      const publishedAtDate =
        (item.isoDate && new Date(item.isoDate)) ||
        (item.pubDate && new Date(item.pubDate)) ||
        new Date();

      const publishedAt = publishedAtDate.toISOString();
      const imageUrl = extractImageUrl(item, htmlContent);
      const videoUrl = extractVideoUrl(item, htmlContent);
      const id = makeArticleId(feed.url, item);

      rawArticles.push({
        id,
        sourceName: feed.sourceName,
        sourceUrl: link,
        title,
        rawText,
        htmlContent,
        imageUrl: imageUrl || null,
        videoUrl: videoUrl || null,
        publishedAt,
        categoryHints: Array.isArray(feed.categoryHints) ? feed.categoryHints : [],
      });
    }
  }

  if (rawArticles.length === 0) {
    console.warn("Δεν βρέθηκαν raw άρθρα από τα feeds.");
  }

  // 2️⃣ Ομαδοποιούμε σε "θέματα" (1 θέμα = 1 ή περισσότερα άρθρα για την ίδια είδηση)
  const topicGroups = groupArticlesByTopic(rawArticles);
  const importantTopicGroups = topicGroups.filter((g) => g.isImportant);

  console.log(`Βρέθηκαν ${topicGroups.length} θεματικές ομάδες άρθρων.`);
  console.log(
    `Θέματα με ΠΟΛΛΕΣ πηγές: ${importantTopicGroups.length} από ${topicGroups.length}`
  );

  const allArticles = [];

  // 3️⃣ Για κάθε θέμα, φτιάχνουμε ΕΝΑ νέο κείμενο με το LLM
  for (const topic of importantTopicGroups) {
    console.log(
      "Απλοποιώ & συνθέτω για θέμα:",
      topic.title,
      "| άρθρα στο θέμα:",
      topic.articles.length
    );

    const result = await simplifyAndClassifyText(topic);
    if (!result || !result.simplifiedText) continue;

    const isSensitive = Boolean(result.isSensitive);

    // Φιλτράρουμε ευαίσθητες ειδήσεις
    if (isSensitive) {
      console.log("Παραλείπω ευαίσθητη είδηση:", topic.title);
      continue;
    }

    const categoryKey =
      result.normalizedCategory || normalizeCategory(result.rawCategory);

    if (!TARGET_CATEGORIES.includes(categoryKey)) {
      console.log(
        `ℹ️ Παράχθηκε κατηγορία εκτός στόχων (${categoryKey}) – το topic δεν θα μπει στο news.json.`
      );
      continue;
    }

    const primary = topic.articles[0];

    // 🧹 Αφαιρούμε διπλότυπες πηγές (ίδιο όνομα & link)
    const sourcesMap = new Map();
    for (const a of topic.articles) {
      const name = a.sourceName || "Άγνωστη πηγή";
      const url = a.sourceUrl || "";
      const key = name + "|" + url;
      if (!sourcesMap.has(key)) {
        sourcesMap.set(key, { sourceName: name, sourceUrl: url });
      }
    }
    const sourceLinks = Array.from(sourcesMap.values()).map((s) => ({
      title: s.sourceName || "Πηγή",
      url: s.sourceUrl || "",
    }));

    // Για συμβατότητα με το frontend:
    // - αν έχουμε μία πηγή → δείχνουμε αυτήν
    // - αν έχουμε πολλές → ενώνουμε τα ονόματα με κόμμα
    let mainSourceName = primary.sourceName || "Πηγή";
    let mainSourceUrl = primary.sourceUrl || "";

    if (sourceLinks.length === 1) {
      mainSourceName = sourceLinks[0].title;
      mainSourceUrl = sourceLinks[0].url;
    } else if (sourceLinks.length > 1) {
      mainSourceName = sourceLinks
        .map((s) => s.title)
        .filter(Boolean)
        .join(", ");
      const firstUrl = sourceLinks.find((s) => s.url)?.url || "";
      mainSourceUrl = firstUrl || primary.sourceUrl || "";
    }

    const sourceUrls = sourceLinks.map((s) => s.url).filter(Boolean);
    let sourceDomains = extractSourceDomains(sourceUrls);

    if (!sourceDomains.length && primary.sourceUrl) {
      sourceDomains = extractSourceDomains([primary.sourceUrl]);
    }

    if (!sourceDomains.length) {
      const nameFallbacks = sourceLinks.map((s) => s.title).filter(Boolean);
      if (nameFallbacks.length) {
        sourceDomains = [...new Set(nameFallbacks)];
      }
    }

    const footer = buildSourcesFooter(sourceDomains);
    const cleanedText = cleanSimplifiedText(result.simplifiedText || "");
    const simpleText = cleanedText + footer;

    allArticles.push({
      id: topic.id,
      title: topic.title, // αρχικός τίτλος (από το πρώτο άρθρο του θέματος)
      simpleTitle: result.simplifiedTitle || topic.title,
      simpleText,

      // "συνοπτική" πηγή για παλιό UI
      sourceName: mainSourceName,
      sourceUrl: mainSourceUrl,
      sourceDomains,
      // 🆕 Πλήρης λίστα με πηγές (τίτλος + URL) για το UI
      sources: sourceLinks,

      category: categoryKey, // ✅ μία από τις CATEGORY_KEYS
      categoryReason: result.categoryReason || "",
      isSensitive,
      imageUrl: topic.imageUrl,
      videoUrl: topic.videoUrl,
      publishedAt: topic.publishedAt,
    });

    console.log(`✅ Προστέθηκε άρθρο κατηγορίας ${categoryKey} στο news.json`);
  }

  // TODO: σε επόμενο βήμα:
  // const openDataArticles = await fetchOpenDataArticlesFromTMDBEtc();
  // allArticles.push(...openDataArticles);

  const dedupedArticles = dedupeArticlesByUrlOrTitle(allArticles);
  allArticles.length = 0;
  allArticles.push(...dedupedArticles);

  await backfillMissingCategories(allArticles);

  const dedupedAfterBackfill = dedupeArticlesByUrlOrTitle(allArticles);
  allArticles.length = 0;
  allArticles.push(...dedupedAfterBackfill);

  const finalArticles = [];

  for (const article of allArticles) {
    const base = { ...article };

    // TESTING FEATURE: generic Pixabay image per category
    const pixabayImage = await fetchPixabayImageForCategory(article.category);
    if (pixabayImage) {
      base.imageUrl = pixabayImage;
    } else if (!base.imageUrl) {
      base.imageUrl = null;
    }

    finalArticles.push(base);
  }

  // ✅ Φτιάχνουμε αντικείμενο με μέχρι MAX_ARTICLES_PER_CATEGORY άρθρα ανά κατηγορία
  const articlesByCategory = buildArticlesByCategory(finalArticles);

  const payload = {
    generatedAt: new Date().toISOString(),
    // flat λίστα όλων των άρθρων (αν θες για ιστορικό)
    articles: finalArticles,
    // και οργανωμένα ανά κατηγορία για την αρχική οθόνη / "ειδήσεις της ημέρας"
    articlesByCategory,
  };

  await fs.writeFile(NEWS_JSON_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    "Έγραψα news.json με",
    finalArticles.length,
    "άρθρα συνολικά. Ανά κατηγορία:",
    Object.fromEntries(
      Object.entries(articlesByCategory).map(([k, v]) => [k, v.length])
    )
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

