import { openai } from "./openaiClient.js";
import { NEWS_CATEGORY_SYSTEM_PROMPT } from "./newsPrompts.js";
import { CATEGORY_KEYS } from "./newsCategories.js";

const CATEGORY_SET = new Set(CATEGORY_KEYS);

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

async function classifyNewsArticle({ title, simpleText, rawText }) {
  const safeTitle = title || "Είδηση";
  const safeSimpleText = simpleText || "";
  const safeRawText = rawText || "";

  const userContent = `Τίτλος: ${safeTitle}\n\nΑπλοποιημένο κείμενο:\n${safeSimpleText}\n\nΑρχικό κείμενο (προαιρετικά):\n${safeRawText}`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    instructions: NEWS_CATEGORY_SYSTEM_PROMPT,
    input: userContent,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "news_category",
        schema: {
          type: "object",
          properties: {
            category: { type: "string", enum: CATEGORY_KEYS },
            reason: { type: "string" },
          },
          required: ["category", "reason"],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  });

  const text = extractText(response).trim();

  try {
    const parsed = JSON.parse(text);
    const category = typeof parsed.category === "string" ? parsed.category : "";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";

    if (CATEGORY_SET.has(category)) {
      return { category, reason: reason || "" };
    }
  } catch (err) {
    // fall through to fallback
  }

  return { category: "other", reason: "JSON parse fallback" };
}

export { classifyNewsArticle };
