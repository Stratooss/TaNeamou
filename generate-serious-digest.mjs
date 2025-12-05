import fs from "fs/promises";
import crypto from "crypto";
import { openai } from "./llm/openaiClient.js";
import {
  SERIOUS_TOPICS_SYSTEM_PROMPT,
  SERIOUS_DIGEST_SYSTEM_PROMPT,
} from "./llm/seriousDigestPrompts.js";

// Paths
const NEWS_PATH = new URL("./news.json", import.meta.url);
const SERIOUS_DIGEST_PATH = new URL("./serious-digest.json", import.meta.url);

// Θεματικές για τις σοβαρές ειδήσεις
const SERIOUS_TOPICS = ["politics_economy", "social", "world"];

// Πόσα θέματα (max) θα δίνουμε ως context σε κάθε θεματική
const MAX_ITEMS_PER_TOPIC = 6;

// ---------- Helpers ----------

// Βοηθός για να πάρουμε text από Responses API (ίδιο pattern με generateLifestyle)
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

function humanLabelForTopic(topic) {
  switch (topic) {
    case "politics_economy":
      return "πολιτική και οικονομική επικαιρότητα";
    case "social":
      return "κοινωνικά θέματα";
    case "world":
      return "παγκόσμια επικαιρότητα";
    default:
      return "σοβαρές ειδήσεις";
  }
}

// Μικρό score: πρώτα πόσα sites (sources.length), μετά πόσο πρόσφατο
function scoreSeriousArticle(article) {
  const sourcesCount = Array.isArray(article.sources)
    ? article.sources.length
    : 1;
  const timeMs = article.publishedAt
    ? new Date(article.publishedAt).getTime()
    : 0;
  // δίνουμε πολύ μεγαλύτερο βάρος στα sites
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

  /** @type {Record<string, string>} */
  const topicById = {};
  for (const row of parsed) {
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

// ---------- Δημιουργία άρθρου με web search για μία θεματική ----------

/**
 * Γράφει ένα νέο άρθρο για ΜΙΑ θεματική (politics_economy | social | world)
 * βασισμένο σε:
 * - mainArticle: το θέμα με τα περισσότερα sites
 * - contextArticles: επιπλέον θέματα της ίδιας θεματικής
 * Χρησιμοποιεί web search για να συμπληρώσει/επικαιροποιήσει.
 */
async function generateDigestForTopic(topic, mainArticle, contextArticles) {
  if (!mainArticle) return null;

  const label = humanLabelForTopic(topic);
  const title = digestTitleForTopic(topic);
  const today = new Date().toISOString().slice(0, 10);

  // payloads με τα ελάχιστα απαραίτητα για το LLM
  const mainPayload = {
    id: mainArticle.id,
    title: mainArticle.simpleTitle || mainArticle.title,
    summary: mainArticle.simpleText || "",
    sources: mainArticle.sources || [],
    publishedAt: mainArticle.publishedAt || null,
  };

  const others = contextArticles
    .filter((a) => a.id !== mainArticle.id)
    .slice(0, MAX_ITEMS_PER_TOPIC - 1)
    .map((a) => ({
      id: a.id,
      title: a.simpleTitle || a.title,
      summary: (a.simpleText || "").slice(0, 800),
      sources: a.sources || [],
      publishedAt: a.publishedAt || null,
    }));

  const userPrompt = `
Σήμερα (${today}) γράφεις ένα άρθρο για: ${label}.

Σου δίνουμε τα πιο σημαντικά θέματα από ελληνικά RSS, ταξινομημένα
με βάση πόσα διαφορετικά sites γράφουν για αυτά.

Το ΚΥΡΙΟ θέμα (αυτό με τα περισσότερα sites) είναι:

${JSON.stringify(mainPayload, null, 2)}

Επιπλέον σχετικά θέματα για context:

${JSON.stringify(others, null, 2)}

Οδηγίες:
1. Χρησιμοποίησε τα παραπάνω ως βάση.
2. Κάνε web search για να δεις:
   - αν υπάρχουν νεότερες πληροφορίες για ΑΥΤΟ το βασικό θέμα,
   - αν υπάρχουν σημαντικές λεπτομέρειες που λείπουν.
3. Γράψε ΕΝΑ ενιαίο άρθρο για το βασικό θέμα, σε πολύ απλά ελληνικά.
4. Εξήγησε με απλά λόγια:
   - τι έγινε,
   - πότε,
   - πού,
   - ποιοι εμπλέκονται,
   - γιατί είναι σημαντικό για τον κόσμο.
5. Στο τέλος γράψε "Πηγές:" και από κάτω bullets
   με σημαντικά sites/άρθρα που χρησιμοποίησες (όνομα + url αν το έχεις).

Μην απαντήσεις με JSON.
Επέστρεψε μόνο καθαρό κείμενο (markdown επιτρέπεται).
`;

  const response = await openai.responses.create({
    model: "gpt-4.1", // Μπορείς να το αλλάξεις σε gpt-4.1-mini αν θέλεις χαμηλότερο κόστος
    instructions: SERIOUS_DIGEST_SYSTEM_PROMPT,
    tools: [{ type: "web_search_preview" }],
    input: userPrompt,
    max_output_tokens: 1600,
  });

  const simpleText = extractTextFromResponse(response).trim();

  return {
    id: crypto.randomUUID(),
    contentType: "agent_serious_digest",
    topic,
    topicLabel: label,
    title,
    simpleText,
    mainArticleId: mainArticle.id,
    relatedArticleIds: others.map((o) => o.id),
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
    console.log("ℹ️ Δεν υπάρχουν σοβαρές ειδήσεις στο news.json – empty digest.");
    const output = {
      generatedAt: new Date().toISOString(),
      articles: [],
    };
    await fs.writeFile(
      SERIOUS_DIGEST_PATH,
      JSON.stringify(output, null, 2),
      "utf-8"
    );
    return;
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

  // Fallbacks: αν μια κατηγορία βγει άδεια, βάζουμε κάποιο από τα υπόλοιπα
  const remaining = [...sortedSerious];
  for (const topic of SERIOUS_TOPICS) {
    if (byTopic[topic].length === 0 && remaining.length) {
      byTopic[topic].push(remaining.shift());
    }
  }

  const digestArticles = [];

  // 4. Για κάθε θεματική, επιλέγουμε τα top N (με βάση score)
  for (const topic of SERIOUS_TOPICS) {
    const items = byTopic[topic];
    if (!items || !items.length) {
      console.log(`ℹ️ Δεν βρέθηκαν θέματα για θεματική ${topic}, skip.`);
      continue;
    }

    const topItems = [...items].sort(
      (a, b) => scoreSeriousArticle(b) - scoreSeriousArticle(a)
    );

    const contextItems = topItems.slice(0, MAX_ITEMS_PER_TOPIC);
    const mainArticle = contextItems[0];

    console.log(
      `🧠 Δημιουργία άρθρου σοβαρής επικαιρότητας για "${topic}" με κύριο θέμα:`,
      mainArticle.simpleTitle || mainArticle.title
    );

    const digest = await generateDigestForTopic(
      topic,
      mainArticle,
      contextItems
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

