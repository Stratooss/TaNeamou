import fs from "fs/promises";
import OpenAI from "openai";
import crypto from "crypto";

// Ίδιο API key
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
    summary: (a.simpleText || "").slice(0, 700),
  }));

  const systemInstructions = `
Είσαι βοηθός που κατατάσσει σοβαρές ειδήσεις σε θεματικές κατηγορίες.

Θεματικές:
- "politics_economy":
  Πολιτική, κυβέρνηση, κόμματα, εκλογές, βουλή, δημόσια διοίκηση,
  εξωτερική πολιτική, διπλωματία, ευρωπαϊκή πολιτική, οικονομία,
  φόροι, μισθοί, συντάξεις, τράπεζες, ΔΝΤ, Ε.Ε. κτλ.
  Εδώ βάζεις ειδήσεις που έχουν ξεκάθαρα ΠΟΛΙΤΙΚΟ ή ΟΙΚΟΝΟΜΙΚΟ χαρακτήρα
  (νόμοι, μέτρα, αποφάσεις, δηλώσεις υπουργών, οικονομικές ανακοινώσεις).

- "social":
  Κοινωνικά θέματα, εκπαίδευση, σχολεία, πανεπιστήμια, υγεία, νοσοκομεία,
  κοινωνικό κράτος, εργασιακά, απεργίες, διαμαρτυρίες, κοινωνικές δράσεις,
  ατυχήματα, τροχαία, εγκλήματα, έρευνες της αστυνομίας, φωτιές,
  φυσικές καταστροφές, θέματα κυκλοφορίας και κίνησης στους δρόμους,
  κοινωνικά προβλήματα (φτώχεια, στέγαση κ.λπ.).
  ΙΔΙΩΣ:
  - Τροχαία δυστυχήματα ή ατυχήματα στην Ελλάδα → ΠΑΝΤΑ "social"
  - Μεγάλη κίνηση, ουρές, κλειστοί δρόμοι, προβλήματα στις μετακινήσεις
    στην Ελλάδα → "social", όχι "world".

- "world":
  Διεθνή θέματα, παγκόσμια γεγονότα, πόλεμοι, διεθνείς κρίσεις,
  διεθνής πολιτική, παγκόσμια οικονομία, γεγονότα σε άλλες χώρες.
  Βάζεις εδώ ειδήσεις όπου το κύριο γεγονός:
  - συμβαίνει σε άλλη χώρα (εκτός Ελλάδας) ή
  - αφορά καθαρά διεθνείς οργανισμούς / διεθνείς σχέσεις.

- "other":
  Οτιδήποτε δεν ταιριάζει ξεκάθαρα σε καμία από τις παραπάνω.

Σημαντικά κριτήρια:

- Αν το γεγονός είναι ΤΡΟΧΑΙΟ, ΑΤΥΧΗΜΑ, ΕΓΚΛΗΜΑ ή ΦΥΣΙΚΗ ΚΑΤΑΣΤΡΟΦΗ
  μέσα στην Ελλάδα, να το βάζεις σχεδόν πάντα "social", όχι "world".
- Αν διστάζεις ανάμεσα σε "world" και "social" ή "politics_economy"
  για ένα γεγονός που γίνεται στην Ελλάδα, προτίμησε "social".
- "world" χρησιμοποίησέ το μόνο αν η βασική ιστορία αφορά άλλη χώρα
  ή καθαρά διεθνές πλαίσιο (π.χ. πόλεμος σε άλλη χώρα, G7, ΝΑΤΟ, ΟΗΕ κτλ.).

Πάντα πρέπει να διαλέγεις ΜΙΑ τιμή από:
"politics_economy", "social", "world", "other".
`;

  const userPrompt = `
Παρακάτω είναι λίστα με σοβαρές ειδήσεις σε JSON.

Για ΚΑΘΕ είδηση, αποφάσισε σε ποια θεματική ανήκει και ΕΠΕΣΤΡΕΨΕ
ΜΟΝΟ JSON πίνακα με αντικείμενα της μορφής:

[
  { "id": "<id-1>", "topic": "politics_economy" },
  { "id": "<id-2>", "topic": "social" },
  ...
]

Χρησιμοποίησε ΜΟΝΟ αυτά τα strings:
"politics_economy", "social", "world", "other".

Ειδήσεις:
${JSON.stringify(items, null, 2)}
`;

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    instructions: systemInstructions,
    input: userPrompt,
    max_output_tokens: 1200,
  });

  const text = extractTextFromResponse(response).trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error("❌ Αποτυχία JSON parse στην ταξινόμηση σοβαρών ειδήσεων:", err);
    return {};
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

  // Μικρό log για να βλέπεις την κατανομή
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

  const systemPrompt = `
Είσαι δημοσιογράφος στην Ελλάδα.
Γράφεις σοβαρές ειδήσεις σε ΠΟΛΥ απλά ελληνικά
για άτομα με ήπια νοητική υστέρηση και μαθησιακές δυσκολίες.

Θεματικές:
- πολιτική & οικονομία,
- κοινωνικά θέματα,
- παγκόσμια επικαιρότητα.

Πάντα:
- Χρησιμοποιείς ΜΙΚΡΕΣ, απλές προτάσεις.
- Αποφεύγεις δύσκολες λέξεις. Αν χρειαστεί, τις εξηγείς με απλά λόγια.
- Δεν γράφεις τεράστιες παραγράφους.
- Δεν αντιγράφεις αυτούσιες φράσεις από τα άρθρα. Πάντα κάνεις παράφραση.
- Χρησιμοποιείς ΜΟΝΟ πληροφορίες που βρίσκεις στα δεδομένα και στο web search.
- Αν τα δεδομένα έχουν παλιές πληροφορίες, τις διορθώνεις/επικαιροποιείς
  με βάση αυτά που θα βρεις στο web search.
- Δεν αλλάζεις ΘΕΜΑ. Μένεις στο ίδιο βασικό γεγονός.

Χειρισμός links και πηγών:
- Δεν βάζεις ΠΟΤΕ links (π.χ. https://..., [τίτλος](url))
  μέσα στις κανονικές παραγράφους του άρθρου.
- Όλα τα links μπαίνουν ΜΟΝΟ στο τέλος, σε ενότητα "Πηγές:".
- Αν υπάρχουν πολλές πηγές από το ίδιο site, μπορείς να τις ενώσεις
  σε μία γραμμή.

Μορφή εξόδου:
- Πρώτη γραμμή: τίτλος (χωρίς #).
- Μετά 3–6 μικρές παραγράφους, σε απλά ελληνικά.
- Μπορείς να χρησιμοποιείς bullets αν βοηθάει (π.χ. λίστα σημείων).
- Στο τέλος, ενότητα:

Πηγές:
- <όνομα site ή σύντομος τίτλος – url αν υπάρχει>
- ...

Κανόνες για την ενότητα "Πηγές":
- Μην προσθέτεις δικές σου φανταστικές πηγές.
- Χρησιμοποίησε ονόματα sites (π.χ. dnews.gr, ertnews.gr, kathimerini.gr).
- Μπορείς να χρησιμοποιήσεις markdown links αν θέλεις
  (π.χ. [dnews.gr](https://...)) αλλά ΜΟΝΟ στην ενότητα "Πηγές:".

Όλο το κείμενο πρέπει να είναι σε ελληνικά.
`;

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

  const response = await client.responses.create({
    model: "gpt-4.1", // Μπορείς να το αλλάξεις σε gpt-4.1-mini αν θέλεις χαμηλότερο κόστος
    instructions: systemPrompt,
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

