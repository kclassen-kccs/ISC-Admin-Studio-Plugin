/**
 * ported/aiDescriptions.js
 * Client-side port of the retired Express server's AI routes: the
 * generate-description routes (entitlements, roles, access profiles, sources,
 * source apps), their bulk generate-all counterparts, the role-scan bulk
 * generate-descriptions, and sources/:id/generate-data.
 *
 * ISC data is fetched here under the user's own token; only the finished
 * prompt goes to the AI proxy (lib/aiProxy.js). Same arguments and return
 * values as the sailpoint.js functions that used to call the routes; failures
 * throw routeError()/badRequest().
 */

import { iscGet, withApiRetry, routeError, badRequest } from "../isc";
import { generateText } from "../aiProxy";
import { mapWithConcurrency, extractAllIdentityEqualsLeaves } from "./roleShared";

const SOURCE_DESCRIPTION_MAX_LENGTH = 255;
const SOURCE_APPS_V1 = "/source-apps/v1";
const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };
const BULK_CONCURRENCY = 3;

/** Cuts text to maxLength at the last word boundary, ending with an ellipsis only if something was dropped. */
function truncateAtWord(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastBreak = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return (lastBreak > maxLength * 0.5 ? cut.slice(0, lastBreak) : cut).replace(/[\s,;:—-]+$/, "") + "…";
}

// Plain-English membership rule for the description prompt — best-effort,
// same EQUALS-leaf extraction the missing-dimension/duplicate-role checks use.
// Falls back to a generic note for shapes it can't confidently describe
// rather than risk feeding the model a wrong summary.
function summarizeMembershipForPrompt(membership) {
  if (!membership) return "No membership rule — members are managed as an explicit list, or none yet.";
  if (membership.type === "IDENTITY_LIST") return "An explicit list of individually-assigned members, not a rule.";
  const leaves = extractAllIdentityEqualsLeaves(membership.criteria);
  if (leaves.length === 0) return "A custom membership rule too complex to summarize automatically.";
  return `Automatically assigned to active identities where ${leaves.map((l) => `${l.attrKey} = "${l.value}"`).join(" and ")}.`;
}

// Shared by every AI role-description path so the prompt wording can't drift
// between an existing role and a not-yet-created one proposed from a scan.
// maxLength, when given, is a hard cap: the prompt asks for it, and the
// result is trimmed at a word boundary if the model runs over anyway.
async function generateDescriptionFromFacts(facts, roleTypeReference, { maxLength } = {}) {
  const lengthHint = maxLength ? ` Keep it under ${maxLength} characters in total — one or two sentences.` : "";
  const description = await generateText(
    `Write a concise (2-4 sentence) description for this SailPoint role, based only on the facts below — don't invent anything not stated. Explain what access it grants and, if there's a membership rule, who gets it automatically. Don't repeat the role's name in the description — refer to it as "${roleTypeReference}" instead. Plain prose, no markdown, no preamble like "Here's a description" — just the description text itself.${lengthHint}\n\n${facts.join("\n")}`
  );
  if (!description) throw new Error("Empty response from Claude.");
  return maxLength ? truncateAtWord(description.trim(), maxLength) : description;
}

const regulatoryFact = (obj) => {
  const regulatory = (obj.accessModelMetadata?.attributes || []).find((a) => a.key === "iscRegulatory");
  return regulatory?.values?.length ? `Regulatory scope: ${regulatory.values.map((v) => v.name).join(", ")}` : null;
};

// ─── Per-object description text (throws; callers decide how to surface it) ──

async function entitlementDescriptionText(id) {
  const entitlement = await withApiRetry(() => iscGet(`/v2026/entitlements/${id}`), { label: `generate-description: fetch entitlement ${id}` });
  return generateDescriptionFromFacts(
    [
      `Entitlement name: ${entitlement.name || entitlement.value}`,
      `Source: ${entitlement.source?.name || "unknown"}`,
      `Source attribute: ${entitlement.attribute || "unknown"}`,
      `Raw value: ${entitlement.value || "unknown"}`,
      `Privilege level: ${entitlement.privilegeLevel?.effective || "unspecified"}`,
    ],
    "This Entitlement"
  );
}

async function roleDescriptionText(roleId) {
  const role = await withApiRetry(() => iscGet(`/v2026/roles/${roleId}`), { label: `generate-description: fetch role ${roleId}` });
  const dimensions = role.dimensional
    ? await withApiRetry(() => iscGet(`/v2026/roles/${roleId}/dimensions`), { label: `generate-description: fetch role ${roleId} dimensions` })
    : [];
  const facts = [
    `Role name: ${role.name}`,
    `Type: ${role.dimensional ? "Dynamic (dimensional)" : "Standard"}`,
    `Membership: ${summarizeMembershipForPrompt(role.membership)}`,
    `Base entitlements (${(role.entitlements || []).length}): ${(role.entitlements || []).map((e) => e.name).join(", ") || "none"}`,
    `Access profiles (${(role.accessProfiles || []).length}): ${(role.accessProfiles || []).map((a) => a.name).join(", ") || "none"}`,
  ];
  if (dimensions.length > 0) {
    facts.push(`Dimensions (${dimensions.length}, each adds entitlements on top of the base for identities matching its own value):`);
    for (const d of dimensions) {
      facts.push(`  - ${d.name}: ${(d.entitlements || []).map((e) => e.name).join(", ") || "no additional entitlements"}`);
    }
  }
  const regulatory = regulatoryFact(role);
  if (regulatory) facts.push(regulatory);
  return generateDescriptionFromFacts(facts, role.dimensional ? "This Dynamic Role" : "This Static Role");
}

async function accessProfileDescriptionText(profileId) {
  const profile = await withApiRetry(() => iscGet(`/v2026/access-profiles/${profileId}`), { label: `generate-description: fetch access profile ${profileId}` });
  const facts = [
    `Access profile name: ${profile.name}`,
    `Source: ${profile.source?.name || "unknown"}`,
    `Requestable: ${profile.requestable ? "yes" : "no"}`,
    // A disabled access profile can't actually be requested regardless of
    // the requestable flag — worth stating rather than relying on the model.
    `Enabled: ${profile.enabled ? "yes" : "no"}${profile.enabled ? "" : " — disabled, so it currently cannot be requested even if marked requestable"}`,
    `Entitlements (${(profile.entitlements || []).length}): ${(profile.entitlements || []).map((e) => e.name).join(", ") || "none"}`,
  ];
  const regulatory = regulatoryFact(profile);
  if (regulatory) facts.push(regulatory);
  return generateDescriptionFromFacts(facts, "This Access Profile");
}

async function sourceDescriptionText(sourceId) {
  const source = await withApiRetry(() => iscGet(`/v2026/sources/${sourceId}`), { label: `generate-description: fetch source ${sourceId}` });
  const facts = [
    `Source name: ${source.name}`,
    `Connector type: ${source.connectorName || source.type || "unknown"}`,
    `Authoritative source: ${source.authoritative ? "yes" : "no"}`,
    `Currently healthy: ${source.healthy ? "yes" : "no"}`,
    `Owner: ${source.owner?.name || "none"}`,
  ];
  if (source.cluster?.name) facts.push(`Cluster: ${source.cluster.name}`);
  if (source.managementWorkgroup?.name) facts.push(`Management workgroup: ${source.managementWorkgroup.name}`);
  // ISC caps a source description at 255 characters, so generation is held to that too.
  return generateDescriptionFromFacts(facts, "This Source", { maxLength: SOURCE_DESCRIPTION_MAX_LENGTH });
}

async function sourceAppDescriptionText(appId) {
  const app = await withApiRetry(() => iscGet(`${SOURCE_APPS_V1}/${appId}`, undefined, EXPERIMENTAL), { label: `generate-description: fetch source app ${appId}` });
  return generateDescriptionFromFacts(
    [
      `Application name: ${app.name}`,
      `Source: ${app.accountSource?.name || "unknown"}`,
      `Enabled: ${app.enabled ? "yes" : "no"}`,
      `Matches all accounts on the source: ${app.matchAllAccounts ? "yes" : "no"}`,
    ],
    "This Application"
  );
}

// ─── Single + bulk wrappers ─────────────────────────────────────────────────

async function single(textFn, id) {
  try {
    return { description: await textFn(id) };
  } catch (err) {
    throw routeError(err);
  }
}

// Results are keyed "roleId" for every object type so the client reuses
// BulkDescriptionReviewSheet unchanged.
async function bulk(textFn, ids, argName) {
  if (!Array.isArray(ids) || ids.length === 0) throw badRequest(`${argName} must be a non-empty array.`);
  const results = await mapWithConcurrency(ids, BULK_CONCURRENCY, async (id) => {
    try {
      return { roleId: id, description: await textFn(id) };
    } catch (err) {
      return { roleId: id, error: routeError(err).message };
    }
  });
  return { results };
}

export const generateEntitlementDescription = (id) => single(entitlementDescriptionText, id);
export const generateAllEntitlementDescriptions = (ids) => bulk(entitlementDescriptionText, ids, "entitlementIds");
export const generateRoleDescription = (id) => single(roleDescriptionText, id);
export const generateAllRoleDescriptions = (ids) => bulk(roleDescriptionText, ids, "roleIds");
export const generateAccessProfileDescription = (id) => single(accessProfileDescriptionText, id);
export const generateAllAccessProfileDescriptions = (ids) => bulk(accessProfileDescriptionText, ids, "accessProfileIds");
export const generateSourceDescription = (id) => single(sourceDescriptionText, id);
export const generateAllSourceDescriptions = (ids) => bulk(sourceDescriptionText, ids, "sourceIds");
export const generateSourceAppDescription = (id) => single(sourceAppDescriptionText, id);
export const generateAllSourceAppDescriptions = (ids) => bulk(sourceAppDescriptionText, ids, "appIds");

/** items: [{ key, name, dimensional, facts }] -> { results: [{ key, description } | { key, error }] } */
export async function generateRoleScanDescriptions(items) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest("items must be a non-empty array.");
  const results = await mapWithConcurrency(items, BULK_CONCURRENCY, async (item) => {
    try {
      const description = await generateDescriptionFromFacts(item.facts || [], item.dimensional ? "This Dynamic Role" : "This Static Role");
      return { key: item.key, description };
    } catch (err) {
      return { key: item.key, error: routeError(err).message };
    }
  });
  return { results };
}

/** AI-modify a source's account CSV. Returns { csv, rows }; nothing is saved. */
export async function generateSourceData(sourceId, { prompt, csvBase64 } = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw badRequest("prompt is required.");
  if (typeof csvBase64 !== "string" || !csvBase64) throw badRequest("csvBase64 is required.");
  try {
    const bytes = Uint8Array.from(atob(csvBase64), (c) => c.charCodeAt(0));
    const csv = new TextDecoder("utf-8").decode(bytes).trim();
    const raw = await generateText(
      `${prompt.trim()}

Current CSV data (the first line is the header):
\`\`\`csv
${csv}
\`\`\`

Return ONLY the complete modified CSV — header line first, every row included, no explanation, no code fences.`,
      { maxTokens: 32000 }
    );
    let out = (raw || "").trim();
    const fence = out.match(/^```(?:csv)?\s*\n([\s\S]*?)\n```$/);
    if (fence) out = fence[1].trim();
    const lines = out.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length < 1 || !lines[0].includes(",")) {
      throw badRequest("The model didn't return usable CSV — try rewording the prompt.", 502);
    }
    return { csv: lines.join("\n"), rows: lines.length - 1 };
  } catch (err) {
    throw routeError(err);
  }
}
