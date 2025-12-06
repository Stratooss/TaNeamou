import { openai } from "./openaiClient.js";
import { NEWS_SIMPLIFY_INSTRUCTIONS } from "./newsPrompts.js";
import { cleanSimplifiedText } from "./textUtils.js";

function extractText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const first = response.output?.[0]?.content?.[0]?.text;
  if (typeof first === "string") return first;
  if (first?.text) return first.text;
  if (first?.value) return first.value;

  throw new Error("Δεν βρέθηκε text στο response του μοντέλου");
}

async function simplifyNewsArticle({ title, rawText, sourceUrl }) {
  const safeTitle = title || "Είδηση";
  const safeText = rawText || "";
  const sourceLine = sourceUrl ? `Πηγή: ${sourceUrl}\n` : "";

  const userContent = `Τίτλος: ${safeTitle}\n${sourceLine}Κείμενο:\n${safeText}`;

  const response = await openai.responses.create({
    model: "gpt-4.1",
    instructions: NEWS_SIMPLIFY_INSTRUCTIONS,
    input: userContent,
  });

  const responseText = extractText(response).trim();
  return cleanSimplifiedText(responseText);
}

export { simplifyNewsArticle };
