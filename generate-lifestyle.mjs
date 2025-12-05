import fs from "fs/promises";
import crypto from "crypto";
import { openai } from "./llm/openaiClient.js";
import { LIFESTYLE_AGENT_SYSTEM_PROMPT } from "./llm/lifestyleAgentPrompts.js";

// Κατηγορίες που θα αντιμετωπίζονται ως lifestyle
const LIFESTYLE_CATEGORIES = [
  "sports",
  "movies",
  "music",
  "theatre",
  "series",
  "fun",
];

// Μέχρι πόσα άρθρα θα τρώει ο agent ανά κατηγορία
const MAX_ITEMS_PER_CATEGORY = 10;

// Paths – προσαρμόσ’ τα αν χρειάζεται
const NEWS_PATH = new URL("./news.json", import.meta.url);
const LIFESTYLE_PATH = new URL("./lifestyle.json", import.meta.url);

// Helper: βγάζουμε text από το Responses API
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

// Τίτλοι ανά κατηγορία για το lifestyle άρθρο
function lifestyleTitleForCategory(category) {
  switch (category) {
    case "sports":
      return "Τα αθλητικά της ημέρας με απλά λόγια";
    case "movies":
      return "Ταινίες και σινεμά σε απλά λόγια";
    case "music":
      return "Μουσική και συναυλίες σε απλά λόγια";
    case "theatre":
      return "Θέατρο και παραστάσεις σε απλά λόγια";
    case "series":
      return "Σειρές και τηλεόραση με απλά λόγια";
    case "fun":
      return "Ιδέες για βόλτες και διασκέδαση";
    default:
      return "Ενημέρωση σε απλά λόγια";
  }
}

// Συγκέντρωση μοναδικών πηγών από τα items (μόνο από RSS δεδομένα)
function uniqueSourcesFromItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const url = item.sourceUrl || item.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push({
      url,
      sourceName: item.sourceName || null,
    });
    if (result.length >= 8) break;
  }
  return result;
}

// Βαθμολογία: πόσα sites (sources.length) + πόσο πρόσφατο
function scoreLifestyleArticle(article) {
  const sourcesCount = Array.isArray(article.sources)
    ? article.sources.length
    : 1;
  const timeMs = article.publishedAt
    ? new Date(article.publishedAt).getTime()
    : 0;
  // Δίνουμε πολύ μεγαλύτερο βάρος στα sites, μετά την ημερομηνία
  return sourcesCount * 1_000_000_000_000 + timeMs;
}

// Ετοιμάζουμε τις πρώτες Ν ειδήσεις ανά κατηγορία
function groupLifestyleArticlesByCategory(allArticles) {
  /** @type {Record<string, any[]>} */
  const grouped = {};
  for (const cat of LIFESTYLE_CATEGORIES) {
    grouped[cat] = [];
  }

  for (const article of allArticles) {
    const cat = article.category;
    if (!LIFESTYLE_CATEGORIES.includes(cat)) continue;
    if (article.isSensitive) continue;

    grouped[cat].push(article);
  }

  // Sort & limit ανά κατηγορία
  for (const cat of LIFESTYLE_CATEGORIES) {
    const items = grouped[cat];

    items.sort((a, b) => scoreLifestyleArticle(b) - scoreLifestyleArticle(a));

    grouped[cat] = items.slice(0, MAX_ITEMS_PER_CATEGORY);
  }

  return grouped;
}

// Κλήση στο OpenAI για μία κατηγορία (με web search) – με mainItem όπως στο serious
async function generateLifestyleArticleForCategory(category, items) {
  if (!items.length) {
    console.log(`ℹ️ Δεν υπάρχουν άρθρα για κατηγορία ${category}, skip.`);
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);

  // 👉 Τα items είναι ήδη ταξινομημένα με scoreLifestyleArticle
  // (περισσότερες πηγές + πιο πρόσφατα)
  const [mainItem, ...restItems] = items;

  const payload = {
    date: today,
    category,
    mainItem: {
      id: mainItem.id,
      title: mainItem.simpleTitle || mainItem.title,
      summary: mainItem.simpleText || "",
      sourceName: mainItem.sourceName || null,
      sourceUrl: mainItem.sourceUrl || null,
      sourcesCount: Array.isArray(mainItem.sources)
        ? mainItem.sources.length
        : 1,
      publishedAt: mainItem.publishedAt || null,
    },
    // Τα υπόλοιπα articles δίνονται μόνο ως context
    contextItems: restItems.map((a) => ({
      id: a.id,
      title: a.simpleTitle || a.title,
      summary: a.simpleText || "",
      sourceName: a.sourceName || null,
      sourceUrl: a.sourceUrl || null,
      sourcesCount: Array.isArray(a.sources) ? a.sources.length : 1,
      publishedAt: a.publishedAt || null,
    })),
  };

  const userContent = `
Κατηγορία (lifestyle): ${category}
Ημερομηνία: ${today}

Παρακάτω είναι τα δεδομένα σε JSON.

- Το ΚΥΡΙΟ γεγονός που πρέπει να περιγράψεις στο άρθρο σου είναι το "mainItem".
- Τα "contextItems" μπορείς να τα χρησιμοποιήσεις ΜΟΝΟ:
  * αν μιλούν για το ίδιο γεγονός (π.χ. άλλα άρθρα για τον ίδιο αγώνα ή την ίδια ταινία),
  * για να συμπληρώσεις μικρές λεπτομέρειες.
- Αν κάποιο contextItem είναι άσχετο γεγονός, αγνόησέ το.

Θέλω:
1) Να γράψεις ΕΝΑ άρθρο μόνο για το "mainItem".
2) Να ΜΗΝ γράψεις πολλές διαφορετικές μικρές ειδήσεις.
3) Να ακολουθήσεις ΠΙΣΤΑ τις οδηγίες του system prompt:
   - πολύ απλά ελληνικά,
   - μικρές προτάσεις,
   - χωρίς δύσκολες λέξεις,
   - χωρίς links μέσα στο κείμενο,
   - μία μόνο ενότητα "Πηγές" στο τέλος.

Δεδομένα (JSON):
${JSON.stringify(payload, null, 2)}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1",
    instructions: LIFESTYLE_AGENT_SYSTEM_PROMPT,
    tools: [{ type: "web_search_preview" }],
    input: userContent,
    max_output_tokens: 1600,
  });

  const simpleText = extractTextFromResponse(response).trim();
  const sources = uniqueSourcesFromItems(items);

  const article = {
    id: crypto.randomUUID(),
    contentType: "agent_lifestyle",
    category,
    date: today,
    title: lifestyleTitleForCategory(category),
    simpleText,
    // Πηγές από τα RSS items που χρησιμοποιήσαμε ως βάση
    sources,
    createdAt: new Date().toISOString(),
  };

  return article;
}

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
  if (!allArticles.length) {
    console.log("ℹ️ Δεν υπάρχουν άρθρα στο news.json");
    return;
  }

  // 2. Φιλτράρουμε μόνο τις lifestyle κατηγορίες και ταξινομούμε με score
  const grouped = groupLifestyleArticlesByCategory(allArticles);

  const lifestyleArticles = [];
  for (const category of LIFESTYLE_CATEGORIES) {
    const items = grouped[category];
    if (!items || !items.length) continue;

    console.log(
      `🧠 Δημιουργία lifestyle άρθρου (με web search) για "${category}" με ${items.length} items...`
    );
    const article = await generateLifestyleArticleForCategory(category, items);
    if (article) lifestyleArticles.push(article);
  }

  if (!lifestyleArticles.length) {
    console.log("ℹ️ Δεν δημιουργήθηκε κανένα lifestyle άρθρο.");
    return;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    articles: lifestyleArticles,
  };

  await fs.writeFile(
    LIFESTYLE_PATH,
    JSON.stringify(output, null, 2),
    "utf-8"
  );

  console.log(
    `✅ lifestyle.json έτοιμο. Κατηγορίες: ${lifestyleArticles
      .map((a) => a.category)
      .join(", ")}`
  );
}

// Εκτέλεση script
main().catch((err) => {
  console.error("❌ Σφάλμα στο generate-lifestyle:", err);
  process.exit(1);
});

