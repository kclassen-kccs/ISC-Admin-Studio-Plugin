/**
 * ported/jsonRepair.js
 * Browser port of POST /api/ai/fix-json: the JSON editors' "fix with AI".
 * Text that doesn't parse goes to the model for SYNTAX repair only (no
 * renamed keys, no changed values, no reformatting) and the result is
 * verified here: it must parse, or the model gets one more try with the new
 * parser error. The caller shows the explanation and the changed lines and
 * the user chooses to apply. The model call goes through lib/aiProxy.js, so
 * by default through the tenant's "Admin Studio AI Query" workflow.
 */

import { badRequest, routeError } from "../isc";
import { generateText } from "../aiProxy";

const JSON_FIX_MAX_CHARS = 60_000;
const JSON_FIX_MARKER = "===FIXED_JSON===";

export function parseJsonFixReply(reply) {
  const at = String(reply || "").indexOf(JSON_FIX_MARKER);
  if (at < 0) return null;
  const explanation = reply.slice(0, at).replace(/^\s*EXPLANATION:\s*/i, "").trim();
  // Tolerate a code fence around the JSON despite being told not to add one.
  const fixed = reply.slice(at + JSON_FIX_MARKER.length).trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  return { explanation, fixed };
}

const INSTRUCTIONS =
  "The text below is meant to be JSON but does not parse. Repair its SYNTAX only, so that it parses as the JSON its " +
  "author clearly intended. Do not rename keys, change or drop values, reorder anything, or reformat / re-indent " +
  "lines you are not fixing — every character that isn't part of a syntax error stays exactly as it is. If something " +
  "is genuinely ambiguous (e.g. a truncated value), make the smallest plausible repair and say so.\n\n" +
  "Reply in exactly this form and nothing else:\n" +
  "EXPLANATION:\n<For someone learning JSON: what was wrong, where (line numbers), why JSON doesn't allow it, and what " +
  "you changed. One short paragraph per problem if there are several. Plain prose, no markdown.>\n" +
  `${JSON_FIX_MARKER}\n<the complete corrected JSON document, with no code fence and nothing after it>`;

/** { fixed, explanation } — `fixed` is guaranteed to parse. */
export async function fixJsonWithAi(textIn, errorIn) {
  const text = String(textIn ?? "");
  const parserError = String(errorIn ?? "").slice(0, 500);
  if (!text.trim()) throw badRequest("There's no JSON to fix.");
  let alreadyValid = false;
  try {
    JSON.parse(text);
    alreadyValid = true;
  } catch { /* expected — that's why we're here */ }
  if (alreadyValid) throw badRequest("This JSON is already valid.");
  if (text.length > JSON_FIX_MAX_CHARS) {
    throw badRequest(`This document is too large for an AI fix (${text.length.toLocaleString()} characters; the limit is ${JSON_FIX_MAX_CHARS.toLocaleString()}). The parser's message gives the line and column to look at.`, 413);
  }
  // The reply repeats the whole document, so the budget scales with it.
  const maxTokens = Math.min(32_000, Math.ceil(text.length / 2.5) + 1_000);

  let prompt = `${INSTRUCTIONS}\n\nThe JSON parser's message: ${parserError || "(none given)"}\n\nThe text:\n${text}`;
  let lastProblem = "The AI provider returned nothing usable.";
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply;
    try {
      reply = await generateText(prompt, { maxTokens });
    } catch (err) {
      throw routeError(err);
    }
    const parsed = parseJsonFixReply(reply);
    if (!parsed) continue;
    try {
      JSON.parse(parsed.fixed);
      return { fixed: parsed.fixed, explanation: parsed.explanation || "The syntax errors were corrected." };
    } catch (err) {
      lastProblem = `The AI's corrected version still didn't parse (${err.message}).`;
      prompt = `${INSTRUCTIONS}\n\nYour previous attempt still did not parse — the parser said: ${err.message}\nFix the ORIGINAL text again, more carefully.\n\nThe original parser message: ${parserError || "(none given)"}\n\nThe text:\n${text}`;
    }
  }
  throw badRequest(`${lastProblem} Nothing was changed — the parser's message gives the line and column to look at.`, 502);
}
