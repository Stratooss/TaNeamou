import fs from "fs/promises";
import crypto from "crypto";
import { openai } from "./llm/openaiClient.js";

import {
  SERIOUS_TOPICS_SYSTEM_PROMPT,
  SERIOUS_DIGEST_SYSTEM_PROMPT,
} from "./llm/seriousDigestPrompts.js";
import {
  cleanSimplifiedText,
  extractSourceDomains,
  extractHostname,
} from "./llm/textUtils.js";

// Paths
const NEWS_PATH = new URL("./news.json", import.meta.url);
const SERIOUS_DIGEST_PATH = new URL("./serious-digest.json", import.meta.url);

// Θεματικές για τις σοβαρές ειδήσεις
const SERIOUS_TOPICS = ["politics_economy", "social", "world"];
const SERIOUS_TOPIC_LABELS = {
  politics_economy: "πολιτική και οικονομική επικαιρότητα",
  social: "κοινωνικά θέματα",
  world: "παγκόσμια επικαιρότητα",
};

// Πόσα θέματα (max) θα εξετάζουμε ανά θεματική πριν διαλέξουμε το καλύτερο mainArticle
const MAX_ITEMS_PER_TOPIC = 6;

const PIXABAY_ALLOWED_PATH_PREFIXES = ["/get/", "/photos/"];
const PIXABAY_ALLOWED_HOSTS = new Set(["pixabay.com", "cdn.pixabay.com"]);
const HTTPS_URL_REGEX = /^https?:\/\//i;

// ---------- Helpers ----------

// Βοηθός για να πάρουμε text από Responses API
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

// Αφαιρεί ενότητα "Πηγές:" (αν την έγραψε το LLM) + inline markdown links
function stripSourcesAndInlineLinks(text) {
  if (!text) return "";

  const idx = text.search(/(^|\n)Πηγές:/);
  let body = idx === -1 ? text : text.slice(0, idx);

  body = body.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, "$1");

  return body.trimEnd();
}

function normalizeUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u}`;
}

function collectSourceUrls(article) {
  if (!article) return [];
  const urls = [];

  if (article.sourceUrl) urls.push(article.sourceUrl);
  if (article.url) urls.push(article.url);

  if (Array.isArray(article.sources)) {
    for (const s of article.sources) {
      if (typeof s === "string") {
        urls.push(normalizeUrl(s));
        continue;
      }
      const u = s?.sourceUrl || s?.url;
      if (u) urls.push(normalizeUrl(u));
    }
  }

  return urls.filter(Boolean);
}

// Παίρνουμε sources από mainArticle (όχι web search)
function buildSourcesFromMainArticle(mainArticle, { max = 4 } = {}) {
  if (!mainArticle) {
    return { sources: [], sourceDomains: [] };
  }

  /** @type {{title: string, url: string}[]} */
  const out = [];
  const seen = new Set();

  // 1) Αν υπάρχει structured sources: [{title,url}]
  if (Array.isArray(mainArticle.sources) && mainArticle.sources.length) {
    for (const s of mainArticle.sources) {
      const title = s?.title || s?.sourceName || mainArticle.sourceName || "Πηγή";
      const url = normalizeUrl(s?.url || s?.sourceUrl || "");
      if (!url) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ title, url });
      if (out.length >= max) break;
    }
  }

  // 2) Fallback στο sourceUrl
  if (out.length < max) {
    const fallbackUrls = collectSourceUrls(mainArticle);
    for (const urlRaw of fallbackUrls) {
      const url = normalizeUrl(urlRaw);
      if (!url) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        title: mainArticle.sourceName || extractHostname(url) || "Πηγή",
        url,
      });
      if (out.length >= max) break;
    }
  }

  const sourceDomains = extractSourceDomains(out.map((s) => s.url).filter(Boolean));
  return { sources: out, sourceDomains };
}

// Τίτλοι για τις 3 θεματικές
function digestTitleForTopic(topic) {
  switch (topic) {
    case "politics_economy":
      return "Πολιτική και οικονομική επικαιρότητα σε απλά λόγια";
    case "social":
      return "Ένα σημαντικό κοινωνικό θέμα σε απλά λόγια";
    case "world":
      return "Παγκόσμια επικαιρότητα σε απλά λόγια";
    default:
      return "Σοβαρή είδηση σε απλά λόγια";
  }
}

// Score: πρώτα πόσα sites (sources.length), μετά πόσο πρόσφατο
function scoreSeriousArticle(article) {
  const sourcesCount = Array.isArray(article.sources) ? article.sources.length : 1;
  const timeMs = article.publishedAt ? new Date(article.publishedAt).getTime() : 0;
  return sourcesCount * 1_000_000_000_000 + timeMs;
}

// ✅ allowlist: ΜΟΝΟ Pixabay images (όχι RSS/original άρθρα)
function isPixabayUrl(url) {
  if (!url || typeof url !== "string") return false;
  const normalized = url.trim();
  if (!HTTPS_URL_REGEX.test(normalized)) return false;
  let u;
  try {
    u = new URL(normalized);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (!PIXABAY_ALLOWED_HOSTS.has(host)) return false;
  if (host === "cdn.pixabay.com") return true;
  return PIXABAY_ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p));
}

// Διαβάζει JSON αν υπάρχει (για "κρατάω το προηγούμενο")
async function readJsonIfExists(urlPath) {
  try {
    const raw = await fs.readFile(urlPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Αν υπήρχε placeholder digest στο παλιό αρχείο, δεν θέλουμε να το “κλειδώσουμε”
function isNoNewsPlaceholderDigest(article) {
  const t = article?.simpleText || "";
  return /Σήμερα δεν βρέθηκε κατάλληλη είδηση/i.test(t);
}

// ---------- Classification: serious → (politics_economy | social | world) ----------

async function classifySeriousArticles(seriousArticles) {
  if (!seriousArticles.length) return {};

  const items = seriousArticles.map((a) => ({
    id: a.id,
    title: a.simpleTitle || a.title,
    summary: (a.simpleText || "").slice(0, 800),
  }));

  const userPrompt = `
Παρακάτω είναι λίστα με σοβαρές ειδήσεις σε JSON.

Για ΚΑΘΕ είδηση, πρέπει να διαλέξεις ΜΙΑ από τις παρακάτω θεματικές τιμές:
- "politics_economy"
- "social"
- "world"
- "other"

και να επιστρέψεις ΜΟΝΟ ένα JSON array της μορφής:

[
  { "id": "<id-1>", "topic": "politics_economy" },
  { "id": "<id-2>", "topic": "social" }
]

Χρησιμοποίησε ΜΟΝΟ αυτά τα strings:
"politics_economy", "social", "world", "other".

Ειδήσεις:
${JSON.stringify(items, null, 2)}
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    instructions: SERIOUS_TOPICS_SYSTEM_PROMPT,
    input: userPrompt,
    max_output_tokens: 800,
    text: {
      format: {
        type: "json_schema",
        name: "SeriousTopics",
        schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  topic: {
                    type: "string",
                    enum: ["politics_economy", "social", "world", "other"],
                  },
                },
                required: ["id", "topic"],
                additionalProperties: false,
              },
            },
          },
          required: ["results"],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  });

  const text = extractTextFromResponse(response).trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(
      "❌ Αποτυχία JSON parse στην ταξινόμηση σοβαρών ειδήσεων, όλα → 'social':",
      err
    );
    const allSocial = {};
    for (const a of seriousArticles) allSocial[a.id] = "social";
    return allSocial;
  }

  const rows = Array.isArray(parsed?.results) ? parsed.results : parsed;

  const topicById = {};
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    const { id, topic } = row;
    if (!id || typeof id !== "string") continue;
    if (!topic || typeof topic !== "string") continue;
    if (!["politics_economy", "social", "world", "other"].includes(topic)) continue;
    topicById[id] = topic;
  }

  for (const a of seriousArticles) {
    if (!topicById[a.id]) topicById[a.id] = "social";
  }

  const counts = { politics_economy: 0, social: 0, world: 0, other: 0 };
  for (const t of Object.values(topicById)) if (counts[t] !== undefined) counts[t]++;
  console.log("📊 Κατανομή σοβαρών ειδήσεων ανά θεματική:", counts);

  return topicById;
}

// ---------- Δημιουργία άρθρου serious digest για μία θεματική (RSS-only) ----------

async function generateSeriousDigestForTopic(topicKey, mainArticle) {
  const topicLabel = SERIOUS_TOPIC_LABELS[topicKey] || "σοβαρές ειδήσεις";
  const title = digestTitleForTopic(topicKey);
  const today = new Date().toISOString().slice(0, 10);
  const hasMain = Boolean(mainArticle);

  // ✅ Αν δεν υπάρχει mainArticle: δεν δημιουργούμε placeholder.
  // Το main() θα κρατήσει το προηγούμενο (αν υπάρχει).
  if (!hasMain) {
    return null;
  }

  const payload = {
    topic: topicKey,
    topicLabel,
    date: today,
    mainArticle: {
      id: mainArticle.id,
      title: mainArticle.simpleTitle || mainArticle.title,
      summary: mainArticle.simpleText || "",
      sourceName: mainArticle.sourceName || null,
      sourceUrl: mainArticle.sourceUrl || null,
      publishedAt: mainArticle.publishedAt || null,
    },
  };

  const userContent = `
Θέμα serious digest: ${topicLabel} (${topicKey})
Ημερομηνία: ${today}

Παρακάτω είναι τα δεδομένα σε JSON για ΜΙΑ σοβαρή είδηση ("mainArticle")
που ανήκει στην ενότητα "${topicLabel}".

Θέλω:

- Να γράψεις ΕΝΑ σύντομο άρθρο που να εξηγεί ΜΟΝΟ αυτή την είδηση με απλά λόγια.
- Να ΜΗΝ προσθέτεις άλλα, άσχετα γεγονότα (ούτε από άλλη πόλη, ούτε από άλλη χώρα).
- Να ΜΗΝ κάνεις γενική σύνοψη πολλών θεμάτων της ημέρας.
- Όλο το κείμενο να αφορά μόνο το "mainArticle".
- Να ΜΗΝ γράφεις πηγές, links ή ονόματα ιστοσελίδων μέσα στο κείμενο.

Δεδομένα (JSON):
${JSON.stringify(payload, null, 2)}
`;

  const response = await openai.responses.create({
    model: "gpt-4o",
    instructions: SERIOUS_DIGEST_SYSTEM_PROMPT,
    input: userContent,
    max_output_tokens: 1600,
  });

  // ✅ Κρατάμε ΜΟΝΟ Pixabay εικόνα (αν υπάρχει στο mainArticle)
  const digestImageUrl = isPixabayUrl(mainArticle?.imageUrl)
    ? mainArticle.imageUrl
    : null;

  let simpleText = extractTextFromResponse(response).trim();
  simpleText = stripSourcesAndInlineLinks(simpleText);
  simpleText = cleanSimplifiedText(simpleText);

  // Πηγές ΜΟΝΟ από mainArticle (RSS)
  const { sources, sourceDomains } = buildSourcesFromMainArticle(mainArticle, { max: 4 });

  const hosts = sources
    .map((s) => extractHostname(s.url))
    .filter(Boolean)
    .join(", ");

  console.log(
    `🧭 sources serious:${topicKey} | rss_sources=${sources.length} hosts=${hosts}`
  );

  return {
    id: crypto.randomUUID(),
    contentType: "agent_serious_digest",
    topic: topicKey,
    topicLabel,
    title,
    simpleText,
    sourceDomains,
    sources,
    mainArticleId: mainArticle.id,
    imageUrl: digestImageUrl,
    relatedArticleIds: [],
    createdAt: new Date().toISOString(),
  };
}

// ---------- Main ----------

async function main() {
  // 0) Διαβάζουμε το προηγούμενο serious-digest.json (για “keep last good content”)
  const prevDigest = await readJsonIfExists(SERIOUS_DIGEST_PATH);
  const prevByTopic = new Map(
    (prevDigest?.articles || [])
      .filter((a) => a && a.topic)
      .map((a) => [a.topic, a])
  );

  // 1. Διαβάζουμε news.json
  let json;
  try {
    const raw = await fs.readFile(NEWS_PATH, "utf-8");
    json = JSON.parse(raw);
  } catch (err) {
    console.error("❌ Πρόβλημα στο διάβασμα του news.json – έλεγξε path/format.");
    console.error(err);
    process.exit(1);
  }

  const allArticles = Array.isArray(json.articles) ? json.articles : [];
  const serious = allArticles.filter((a) => a.category === "serious" && !a.isSensitive);

  if (!serious.length) {
    console.log("ℹ️ Δεν υπάρχουν σοβαρές ειδήσεις στο news.json (RSS-only).");
  }

  // 2. Ταξινόμηση σοβαρών ειδήσεων
  const sortedSerious = [...serious].sort(
    (a, b) => scoreSeriousArticle(b) - scoreSeriousArticle(a)
  );

  // 3. Ζητάμε από LLM να τις κατηγοριοποιήσει σε 3 θεματικές
  console.log("🧠 Ταξινόμηση σοβαρών ειδήσεων σε πολιτική/κοινωνικό/παγκόσμιο...");
  const topicById = await classifySeriousArticles(sortedSerious);

  const byTopic = { politics_economy: [], social: [], world: [] };

  for (const article of sortedSerious) {
    const topic = topicById[article.id] || "other";
    if (byTopic[topic]) byTopic[topic].push(article);
  }

  const digestArticles = [];

  // 4. Για κάθε θεματική, επιλέγουμε mainArticle ή κρατάμε το προηγούμενο
  for (const topic of SERIOUS_TOPICS) {
    const items = byTopic[topic] || [];
    const sortedItems = [...items].sort(
      (a, b) => scoreSeriousArticle(b) - scoreSeriousArticle(a)
    );
    const contextItems = sortedItems.slice(0, MAX_ITEMS_PER_TOPIC);
    const [mainArticle] = contextItems;

    if (mainArticle) {
      console.log(
        `🧠 Δημιουργία άρθρου σοβαρής επικαιρότητας για "${topic}" με κύριο θέμα:`,
        mainArticle.simpleTitle || mainArticle.title
      );

      const digest = await generateSeriousDigestForTopic(topic, mainArticle);
      if (digest) {
        digestArticles.push(digest);
        continue;
      }
    }

    // 🔒 Δεν υπάρχει νέο mainArticle: κράτα το προηγούμενο (αν υπάρχει και δεν είναι placeholder)
    const prev = prevByTopic.get(topic);
    if (prev && !isNoNewsPlaceholderDigest(prev)) {
      console.log(
        `ℹ️ Δεν βρέθηκε νέο mainArticle για "${topic}". Κρατάω το προηγούμενο digest.`
      );
      digestArticles.push(prev);
    } else {
      console.log(
        `ℹ️ Δεν βρέθηκε νέο mainArticle για "${topic}" και δεν υπάρχει προηγούμενο digest. Παραλείπεται.`
      );
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    articles: digestArticles,
  };

  await fs.writeFile(SERIOUS_DIGEST_PATH, JSON.stringify(output, null, 2), "utf-8");

  console.log(
    `✅ serious-digest.json έτοιμο. Θεματικές: ${digestArticles.map((a) => a.topic).join(", ")}`
  );
}

main().catch((err) => {
  console.error("❌ Σφάλμα στο generate-serious-digest:", err);
  process.exit(1);
});
