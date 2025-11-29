import fs from "fs/promises";
import Parser from "rss-parser";
import OpenAI from "openai";

// Χρησιμοποιούμε το κλειδί από τα GitHub Secrets
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// RSS feeds που θα διαβάζουμε (βάζουμε 1 για αρχή)
const FEEDS = [
  {
    url: "https://www.ertnews.gr/feed", // αργότερα μπορούμε να προσθέσουμε κι άλλα
    sourceName: "ERT News",
  },
];

const parser = new Parser();

// Πολύ απλό καθάρισμα HTML -> απλό κείμενο
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Κλήση στο AI για απλοποίηση κειμένου
async function simplifyText(title, text) {
  const input = `Τίτλος: ${title}\n\nΚείμενο:\n${text}`;

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    instructions:
      "Είσαι δημοσιογράφος που γράφει πολύ απλά ελληνικά για άτομα με νοητική υστέρηση. " +
      "Ξαναγράψε το κείμενο με: " +
      "1) πολύ απλές, σύντομες προτάσεις, " +
      "2) χωρίς δύσκολες λέξεις αν γίνεται, " +
      "3) εξήγηση των δύσκολων εννοιών με απλά παραδείγματα, " +
      "4) συνολικό μήκος έως περίπου 10-12 προτάσεις.",
    input,
  });

  return response.output_text;
}

async function run() {
  const articles = [];

  for (const feed of FEEDS) {
    console.log("Διαβάζω feed:", feed.url);
    const rss = await parser.parseURL(feed.url);

    // Παίρνουμε π.χ. τις 5 πιο πρόσφατες ειδήσεις
    const items = (rss.items || []).slice(0, 5);

    for (const item of items) {
      const title = item.title || "";
      const link = item.link || "";
      const raw =
        stripHtml(item.contentSnippet || item.content || item.summary || "") ||
        "";

      if (!raw) continue;

      // Κόβουμε το κείμενο για να μην είναι τεράστιο (λιγότερο κόστος)
      const textForModel = raw.slice(0, 2000);

      console.log("Απλοποιώ:", title);
      const simple = await simplifyText(title, textForModel);

      if (!simple) continue;

      articles.push({
        title,
        simpleText: simple,
        sourceUrl: link,
        sourceName: feed.sourceName,
      });
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    articles,
  };

  await fs.writeFile("news.json", JSON.stringify(payload, null, 2), "utf8");
  console.log("Έγραψα news.json με", articles.length, "άρθρα");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
