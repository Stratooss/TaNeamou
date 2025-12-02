import fs from "fs/promises";
import Parser from "rss-parser";
import OpenAI from "openai";
import crypto from "crypto";
import { NEWS_SIMPLIFY_INSTRUCTIONS } from "./newsLlmInstructions.js";

// Χρησιμοποιούμε το κλειδί από τα GitHub Secrets
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ✅ Εσωτερικές κατηγορίες που θα υποστηρίζουμε
// Αυτές οι τιμές πρέπει να χρησιμοποιούνται και στο NEWS_SIMPLIFY_INSTRUCTIONS
export const CATEGORY_KEYS = [
  "serious",   // Σοβαρές ειδήσεις (οικονομία, πολιτική, σοβαρά κοινωνικά)
  "sports",    // Αθλητισμός
  "movies",    // Ταινίες
  "music",     // Μουσική
  "theatre",   // Θέατρο
  "series",    // Σειρές
  "fun",       // Διασκέδαση (bars, βόλτες, nightlife, εστιατόρια κτλ.)
  "other",     // Ό,τι δεν ταιριάζει αλλού
];

// RSS feeds που θα διαβάζουμε
// Προς το παρόν μόνο ERT, αλλά εδώ θα προσθέτεις και άλλα.
// Η κατηγοριοποίηση γίνεται από το LLM.
const FEEDS = [
  {
    url: "https://www.ertnews.gr/feed",
    sourceName: "ERT News",
  },
  // αργότερα:
  // { url: "https://www.athinorama.gr/feed", sourceName: "Athinorama" },
  // { url: "https://www.culturenow.gr/feed", sourceName: "CultureNow" },
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
  if (!rawCategory) return "other";
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

  // Αθλητισμός
  if (["sports", "sport", "αθλητισμος", "αθλητισμός"].includes(c)) {
    return "sports";
  }

  // Ταινίες
  if (
    ["movies", "movie", "ταινιες", "ταινίες", "cinema", "σινεμα", "σινεμά"].includes(
      c
    )
  ) {
    return "movies";
  }

  // Μουσική
  if (["music", "μουσικη", "μουσική"].includes(c)) {
    return "music";
  }

  // Θέατρο
  if (["theatre", "theater", "θεατρο", "θέατρο"].includes(c)) {
    return "theatre";
  }

  // Σειρές
  if (["series", "tv", "σειρες", "σειρές"].includes(c)) {
    return "series";
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

  return "other";
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

// Κλήση στο AI για απλοποίηση + κατηγοριοποίηση + παραφρασμένο τίτλο
// 🆕 ΠΛΕΟΝ παίρνει ΟΛΟ το "θέμα" (1 ή περισσότερα άρθρα).
async function simplifyAndClassifyText(topicGroup) {
  const { articles } = topicGroup;
  if (!articles || articles.length === 0) {
    return null;
  }

  const parts = [];

  parts.push(
    "Παρακάτω θα δεις πληροφορίες για ΜΙΑ είδηση, από ΕΝΑ ή ΠΕΡΙΣΣΟΤΕΡΑ άρθρα.\n" +
      "Όλα τα άρθρα μιλούν για το ίδιο γεγονός. " +
      "Χρησιμοποίησε όλες αυτές τις πληροφορίες σαν υλικό για να γράψεις ΕΝΑ νέο κείμενο σε πολύ απλά ελληνικά."
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

  const input = parts.join("\n");

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    instructions: NEWS_SIMPLIFY_INSTRUCTIONS,
    input,
  });

  const textOut = response.output_text;
  try {
    const parsed = JSON.parse(textOut);
    return {
      simplifiedText: parsed.simplifiedText || "",
      simplifiedTitle: parsed.simplifiedTitle || parsed.simpleTitle || "",
      rawCategory: parsed.category || "other",
      isSensitive: Boolean(parsed.isSensitive),
    };
  } catch (err) {
    console.error(
      "JSON parse error από το μοντέλο, fallback σε απλό κείμενο:",
      err
    );
    return {
      simplifiedText: textOut,
      simplifiedTitle: "",
      rawCategory: "other",
      isSensitive: false,
    };
  }
}

// helper: είναι η είδηση μέσα στο τελευταίο 24ωρο;
function isWithinLast24Hours(date, now = new Date()) {
  const diffMs = now.getTime() - date.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  return diffMs >= 0 && diffMs <= oneDayMs;
}

// 💡 επιλέγουμε μέχρι 6 άρθρα ανά κατηγορία για "ειδήσεις της ημέρας"
function buildArticlesByCategory(allArticles) {
  const now = new Date();

  /** @type {Record<string, any[]>} */
  const byCategory = {};
  for (const key of CATEGORY_KEYS) {
    byCategory[key] = [];
  }

  for (const article of allArticles) {
    const cat = article.category || "other";
    if (!byCategory[cat]) {
      byCategory["other"].push(article);
    } else {
      byCategory[cat].push(article);
    }
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

    let selected = todayItems.slice(0, 6);

    // Αν δεν φτάνουν οι "τελείως σημερινές", συμπληρώνουμε από τις πιο παλιές
    if (selected.length < 6) {
      const remaining = items.filter((i) => !todayItems.includes(i));
      selected = selected.concat(remaining.slice(0, 6 - selected.length));
    }

    result[key] = selected;
  }

  return result;
}

// 🧱 Ομαδοποίηση raw άρθρων σε "θέματα" με βάση τον τίτλο
function groupArticlesByTopic(rawArticles) {
  const groupsByKey = new Map();

  for (const article of rawArticles) {
    const normTitle = normalizeTitleForGrouping(article.title);
    const key = normTitle || article.id; // fallback: μοναδικό id αν δεν υπάρχει τίτλος

    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        key,
        articles: [],
      };
      groupsByKey.set(key, group);
    }
    group.articles.push(article);
  }

  const topicGroups = [];

  for (const group of groupsByKey.values()) {
    const primary = group.articles[0];

    // publishedAt = πιο πρόσφατο από την ομάδα
    let latestPublishedAt = primary.publishedAt;
    for (const a of group.articles) {
      if (new Date(a.publishedAt) > new Date(latestPublishedAt)) {
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

    topicGroups.push({
      id: groupId,
      key: group.key,
      title: primary.title,
      articles: group.articles,
      imageUrl,
      videoUrl,
      publishedAt: latestPublishedAt,
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
      });
    }
  }

  if (rawArticles.length === 0) {
    console.warn("Δεν βρέθηκαν raw άρθρα από τα feeds.");
  }

  // 2️⃣ Ομαδοποιούμε σε "θέματα" (1 θέμα = 1 ή περισσότερα άρθρα για την ίδια είδηση)
  const topicGroups = groupArticlesByTopic(rawArticles);
  console.log("Βρέθηκαν", topicGroups.length, "θεματικές ομάδες άρθρων.");

  const allArticles = [];

  // 3️⃣ Για κάθε θέμα, φτιάχνουμε ΕΝΑ νέο κείμενο με το LLM
  for (const topic of topicGroups) {
    console.log("Απλοποιώ & συνθέτω για θέμα:", topic.title);

    const result = await simplifyAndClassifyText(topic);
    if (!result || !result.simplifiedText) continue;

    // Φιλτράρουμε ευαίσθητες ειδήσεις
    if (result.isSensitive) {
      console.log("Παραλείπω ευαίσθητη είδηση:", topic.title);
      continue;
    }

    const categoryKey = normalizeCategory(result.rawCategory);

    const primary = topic.articles[0];
    const sources = topic.articles.map((a) => ({
      sourceName: a.sourceName,
      sourceUrl: a.sourceUrl,
    }));

    allArticles.push({
      id: topic.id,
      title: topic.title, // αρχικός τίτλος (από το πρώτο άρθρο του θέματος)
      simpleTitle: result.simplifiedTitle || topic.title,
      simpleText: result.simplifiedText,
      sourceName: primary.sourceName,
      sourceUrl: primary.sourceUrl,
      // 🆕 ΠΛΗΡΗΣ λίστα με 2–3+ πηγές
      sources,
      category: categoryKey, // ✅ μία από τις CATEGORY_KEYS
      isSensitive: false,
      imageUrl: topic.imageUrl,
      videoUrl: topic.videoUrl,
      publishedAt: topic.publishedAt,
    });
  }

  // TODO: σε επόμενο βήμα:
  // const openDataArticles = await fetchOpenDataArticlesFromTMDBEtc();
  // allArticles.push(...openDataArticles);

  // ✅ Φτιάχνουμε αντικείμενο με μέχρι 6 άρθρα ανά κατηγορία
  const articlesByCategory = buildArticlesByCategory(allArticles);

  const payload = {
    generatedAt: new Date().toISOString(),
    // flat λίστα όλων των άρθρων (αν θες για ιστορικό)
    articles: allArticles,
    // και οργανωμένα ανά κατηγορία για την αρχική οθόνη / "ειδήσεις της ημέρας"
    articlesByCategory,
  };

  await fs.writeFile("news.json", JSON.stringify(payload, null, 2), "utf8");
  console.log(
    "Έγραψα news.json με",
    allArticles.length,
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
