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

  // Κρατάμε μόνο το κομμάτι πριν από οποιαδήποτε γραμμή που ξεκινά με "Πηγές:"
  const idx = text.search(/(^|\n)Πηγές:/);
  let body = idx === -1 ? text : text.slice(0, idx);

  // Αφαιρούμε inline markdown links [κείμενο](http...)
  body = body.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, "$1");

  return body.trimEnd();
}

function collectSourceUrls(article) {
  if (!article) return [];
  const urls = [];

  if (article.sourceUrl) urls.push(article.sourceUrl);
  if (article.url) urls.push(article.url);

  if (Array.isArray(article.sources)) {
    for (const s of article.sources) {
      if (typeof s === "string") {
        urls.push(/^https?:\/\//.test(s) ? s : `https://${s}`);
        continue;
      }
      const u = s?.sourceUrl || s?.url;
      if (u) urls.push(u);
    }
  }

  return urls.filter(Boolean);
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
  const sourcesCount = Array.isArray(article.sources)
    ? article.sources.length
    : 1;
  const timeMs = article.publishedAt
    ? new Date(article.publishedAt).getTime()
    : 0;
  // δίνουμε πολύ μεγαλύτερο βάρος στα πολλά sites
  return sourcesCount * 1_000_000_000_000 + timeMs;
}

// ---------- Classification: serious → (politics_economy | social | world) ----------

/**
 * Ζητάμε από ένα μικρό LLM να κατατάξει κάθε σοβαρή είδηση
 * σε μία από τις θεματικές: politics_economy | social | world | other.
 * Επιστρέφει map: id -> topic
 */
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
    // Fallback: αν γίνει χαμός, τουλάχιστον όλα να θεωρηθούν "social"
    /** @type {Record<string, string>} */
    const allSocial = {};
    for (const a of seriousArticles) {
      allSocial[a.id] = "social";
    }
    return allSocial;
  }

  // Accept either wrapped { results: [...] } or bare array fallback
  const rows = Array.isArray(parsed?.results) ? parsed.results : parsed;

  /** @type {Record<string, string>} */
  const topicById = {};
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    const { id, topic } = row;
    if (!id || typeof id !== "string") continue;
    if (!topic || typeof topic !== "string") continue;
    if (!["politics_economy", "social", "world", "other"].includes(topic)) {
      continue;
    }
    topicById[id] = topic;
  }

  // Ό,τι δεν ταξινομήθηκε ρητά από το μοντέλο, default "social"
  for (const a of seriousArticles) {
    if (!topicById[a.id]) {
      topicById[a.id] = "social";
    }
  }

  const counts = { politics_economy: 0, social: 0, world: 0, other: 0 };
  for (const t of Object.values(topicById)) {
    if (counts[t] !== undefined) counts[t]++;
  }
  console.log("📊 Κατανομή σοβαρών ειδήσεων ανά θεματική:", counts);

  return topicById;
}

// ---------- Δημιουργία άρθρου serious digest για μία θεματική ----------

async function generateSeriousDigestForTopic(topicKey, mainArticle) {
  const topicLabel = SERIOUS_TOPIC_LABELS[topicKey] || "σοβαρές ειδήσεις";
  const title = digestTitleForTopic(topicKey);
  const today = new Date().toISOString().slice(0, 10);
  const hasMain = Boolean(mainArticle);

  const payload = {
    topic: topicKey,
    topicLabel,
    date: today,
    mainArticle: hasMain
      ? {
          id: mainArticle.id,
          title: mainArticle.simpleTitle || mainArticle.title,
          summary: mainArticle.simpleText || "",
          sourceName: mainArticle.sourceName || null,
          sourceUrl: mainArticle.sourceUrl || null,
          publishedAt: mainArticle.publishedAt || null,
        }
      : null,
  };

  let userContent;

  if (hasMain) {
    // 🔹 ΕΝΑ γεγονός για κάθε θεματική (πολιτική-οικονομία, κοινωνικά, κόσμος)
    userContent = `

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
  } else {
    userContent = `

Θέμα serious digest: ${topicLabel} (${topicKey})
Ημερομηνία: ${today}

Δεν βρέθηκαν καθόλου κατάλληλα άρθρα στο δικό μας news.json για αυτή την ενότητα.

Θέλω:

- Να χρησιμοποιήσεις ΜΟΝΟ web search (εργαλείο web_search_preview)
  για να βρεις ΕΝΑ σημαντικό γεγονός της ημέρας που ανήκει στην ενότητα "${topicLabel}".
- Να γράψεις ΕΝΑ άρθρο σε απλά ελληνικά, σαν ενημέρωση για ενήλικες με ήπιες νοητικές δυσκολίες.
- Να ΜΗΝ εφευρίσκεις γεγονότα.
- Να ΜΗΝ κάνεις γενική σύνοψη πολλών θεμάτων (γράψε για ΕΝΑ βασικό γεγονός).
- Να ΜΗΝ γράφεις πηγές, links ή ονόματα ιστοσελίδων μέσα στο κείμενο.

Για αναφορά, τα metadata σε JSON (δεν περιέχουν άρθρα):
${JSON.stringify(payload, null, 2)}
`;

    console.log(`ℹ️ Fallback με web search για serious topic ${topicKey}`);
  }

  const response = await openai.responses.create({
    model: "gpt-4.1",
    instructions: SERIOUS_DIGEST_SYSTEM_PROMPT,
    tools: [{ type: "web_search_preview" }],
    input: userContent,
    max_output_tokens: 1600,
  });

  let simpleText = extractTextFromResponse(response).trim();
  simpleText = stripSourcesAndInlineLinks(simpleText);
  simpleText = cleanSimplifiedText(simpleText);

  const sourceUrls = [];
  if (hasMain) {
    sourceUrls.push(...collectSourceUrls(mainArticle));
  }

  let sourceDomains = extractSourceDomains(sourceUrls);

  if (!sourceDomains.length && !hasMain) {
    sourceDomains = ["web.search"];
  }

  if (!sourceDomains.length && hasMain) {
    const nameFallbacks = [];
    if (mainArticle?.sourceName) nameFallbacks.push(mainArticle.sourceName);
    if (nameFallbacks.length) {
      sourceDomains = [...new Set(nameFallbacks)];
    }
  }

  return {
    id: crypto.randomUUID(),
    contentType: "agent_serious_digest",
    topic: topicKey,
    topicLabel,
    title,
    simpleText,
    sources: sourceDomains,
    mainArticleId: hasMain ? mainArticle.id : null,
    relatedArticleIds: [], // δεν χρησιμοποιούμε πλέον related, ένα γεγονός ανά θεματική
    createdAt: new Date().toISOString(),
  };
}

// ---------- Main ----------

async function main() {
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
  const serious = allArticles.filter(
    (a) => a.category === "serious" && !a.isSensitive
  );

  if (!serious.length) {
    console.log(
      "ℹ️ Δεν υπάρχουν σοβαρές ειδήσεις στο news.json – θα χρησιμοποιήσουμε web search για κάθε θεματική."
    );
  }

  // 2. Ταξινόμηση σοβαρών ειδήσεων με βάση:
  //    - πόσα sites (sources.length)
  //    - πόσο πρόσφατες είναι
  const sortedSerious = [...serious].sort(
    (a, b) => scoreSeriousArticle(b) - scoreSeriousArticle(a)
  );

  // 3. Ζητάμε από LLM να τις κατηγοριοποιήσει σε 3 θεματικές
  console.log("🧠 Ταξινόμηση σοβαρών ειδήσεων σε πολιτική/κοινωνικό/παγκόσμιο...");
  const topicById = await classifySeriousArticles(sortedSerious);

  /** @type {Record<string, any[]>} */
  const byTopic = {
    politics_economy: [],
    social: [],
    world: [],
  };

  for (const article of sortedSerious) {
    const topic = topicById[article.id] || "other";
    if (byTopic[topic]) {
      byTopic[topic].push(article);
    }
  }

  const digestArticles = [];

  // 4. Για κάθε θεματική, επιλέγουμε το καλύτερο mainArticle ή fallback web search
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
    } else {
      console.log(
        `🧠 Fallback web search για θεματική "${topic}" (χωρίς άρθρα από RSS).`
      );
    }

    const digest = await generateSeriousDigestForTopic(
      topic,
      mainArticle || null
    );

    if (digest) {
      digestArticles.push(digest);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    articles: digestArticles,
  };

  await fs.writeFile(
    SERIOUS_DIGEST_PATH,
    JSON.stringify(output, null, 2),
    "utf-8"
  );

  console.log(
    `✅ serious-digest.json έτοιμο. Θεματικές: ${digestArticles
      .map((a) => a.topic)
      .join(", ")}`
  );
}

main().catch((err) => {
  console.error("❌ Σφάλμα στο generate-serious-digest:", err);
  process.exit(1);
});

