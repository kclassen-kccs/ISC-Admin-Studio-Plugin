/**
 * ported/workgroups.js
 * Browser-side port of the old Express /api/workgroups/* write routes
 * (create, patch, delete, members, usage). Reads go through the generic
 * ISC passthrough; these are here because ISC wants a JSON Patch for the
 * group itself and per-chunk bulk calls for members.
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError()/badRequest() so callers still read err.response.data.error.
 */

import { iscGet, iscPost, iscPatch, iscDelete, fetchAllPaged, withApiRetry, describeError, routeError, badRequest } from "../isc";

/** POST /api/workgroups { name, description, owner: {id,name} } */
export async function createGovernanceGroup(fields) {
  const { name, description, owner } = fields || {};
  if (!name || !String(name).trim()) throw badRequest("name is required.");
  if (!owner?.id) throw badRequest("owner is required.");
  try {
    return await iscPost("/v2026/workgroups", {
      name: String(name).trim(),
      description: description || "",
      owner: { type: "IDENTITY", id: owner.id, name: owner.name },
    });
  } catch (err) {
    console.error("[workgroups] create failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * PATCH /api/workgroups/:id { name?, description?, owner? } — the three
 * fields ISC lets you patch on a governance group.
 */
export async function updateGovernanceGroup(id, fields) {
  const { name, description, owner } = fields || {};
  const ops = [];
  if (name !== undefined) {
    if (!name || !String(name).trim()) throw badRequest("name can't be empty.");
    ops.push({ op: "replace", path: "/name", value: String(name).trim() });
  }
  if (description !== undefined) ops.push({ op: "replace", path: "/description", value: description });
  if (owner !== undefined) {
    if (!owner?.id) throw badRequest("owner must have an id.");
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (ops.length === 0) throw badRequest("Provide at least one field to update.");
  try {
    return await iscPatch(`/v2026/workgroups/${encodeURIComponent(id)}`, ops);
  } catch (err) {
    console.error("[workgroups] edit failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/** DELETE /api/workgroups/:id */
export async function deleteGovernanceGroup(id) {
  try {
    await iscDelete(`/v2026/workgroups/${encodeURIComponent(id)}`);
    console.log(`[workgroups] deleted ${id}`);
  } catch (err) {
    console.error("[workgroups] delete failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * POST /api/workgroups/:id/members { add: [{id,name}], remove: [{id,name}] }
 * — bulk-add / bulk-delete in chunks of 100. Reports per-chunk failures:
 * { added, removed, errors }.
 */
export async function updateGovernanceGroupMembers(id, body) {
  const toRef = (m) => ({ type: "IDENTITY", id: String(m.id), ...(m.name ? { name: String(m.name) } : {}) });
  const add = (Array.isArray(body?.add) ? body.add : []).filter((m) => m?.id).map(toRef);
  const remove = (Array.isArray(body?.remove) ? body.remove : []).filter((m) => m?.id).map(toRef);
  if (!add.length && !remove.length) throw badRequest("Nothing to add or remove.");
  try {
    const errors = [];
    let added = 0;
    let removed = 0;
    for (const [op, list] of [["bulk-add", add], ["bulk-delete", remove]]) {
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        try {
          await withApiRetry(
            () => iscPost(`/v2026/workgroups/${encodeURIComponent(id)}/members/${op}`, chunk),
            { label: `workgroup ${id} ${op}` }
          );
          if (op === "bulk-add") added += chunk.length; else removed += chunk.length;
        } catch (err) {
          errors.push(`${op === "bulk-add" ? "Adding" : "Removing"} ${chunk.length}: ${describeError(err)}`);
        }
      }
    }
    console.log(`[workgroups] members of ${id}: +${added} -${removed}${errors.length ? `, ${errors.length} failed` : ""}`);
    return { added, removed, errors };
  } catch (err) {
    throw routeError(err);
  }
}

// Where in an object a governance group's id appears, as readable labels
// ("Additional owner", "Access request approver", …). Scans the whole object
// so a reference ISC adds in a new field still shows (labelled by its path).
function workgroupRefLabels(obj, groupId) {
  const hits = [];
  const walk = (node, path) => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (typeof node === "object") return Object.entries(node).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k));
    if (node === groupId && path) hits.push(path);
  };
  walk(obj, "");
  const labelFor = (p) => {
    if (/^additionalOwners/.test(p)) return "Additional owner";
    if (/^managementWorkgroup/.test(p)) return "Management workgroup (additional owner)";
    if (/^owner\b/.test(p)) return "Owner";
    if (/^accessRequestConfig\.approvalSchemes/.test(p)) return "Access request approver";
    if (/^revokeRequestConfig\.approvalSchemes|^revocationRequestConfig/.test(p)) return "Revoke request approver";
    if (/violationOwnerAssignmentConfig/.test(p)) return "Violation owner";
    if (/^secondaryOwnerRefs/.test(p)) return "Secondary owner";
    if (/^ownerRef/.test(p)) return "Owner";
    if (/^definition|^trigger/.test(p)) return "Referenced in workflow steps";
    return p.replace(/\[\d+\]/g, "").replace(/\.id$/, "");
  };
  return [...new Set(hits.filter((p) => p !== "id").map(labelFor))];
}

/**
 * GET /api/workgroups/:id/usage — where this governance group is used.
 * ISC's own connections list (access-request reviewer, owner, management
 * workgroup) plus a scan of roles, access profiles, sources, SOD policies
 * and workflows for the group's id. Entitlements are too many to scan, so
 * they only show when ISC's connections list reports them.
 * { usage: [{ type, id, name, how: [labels] }], errors }
 */
export async function getGovernanceGroupUsage(groupId) {
  try {
    const usage = [];
    const errors = [];
    const seen = new Set();
    const push = (type, obj, how) => {
      const key = `${type}:${obj.id}:${how.join(",")}`;
      if (seen.has(key)) return;
      seen.add(key);
      usage.push({ type, id: obj.id, name: obj.name || obj.displayName || obj.id, how });
    };

    const scans = [
      ["CONNECTIONS", async () => {
        const list = await fetchAllPaged(`/v2026/workgroups/${encodeURIComponent(groupId)}/connections`, {}, 50);
        for (const c of list) {
          const o = c.object || {};
          const how = { AccessRequestReviewer: "Access request reviewer", Owner: "Owner", ManagementWorkgroup: "Management workgroup (additional owner)" }[c.connectionType] || c.connectionType;
          push(o.type || "OBJECT", o, [how]);
        }
      }],
      ["ROLE", () => fetchAllPaged("/v2026/roles")],
      ["ACCESS_PROFILE", () => fetchAllPaged("/v2026/access-profiles")],
      ["SOURCE", () => fetchAllPaged("/v2026/sources")],
      ["SOD_POLICY", () => fetchAllPaged("/v2026/sod-policies")],
      ["WORKFLOW", () => iscGet("/v2026/workflows")],
    ];
    await Promise.all(scans.map(async ([type, fn]) => {
      try {
        const list = await fn();
        if (type === "CONNECTIONS" || !Array.isArray(list)) return;
        for (const obj of list) {
          if (!JSON.stringify(obj).includes(groupId)) continue;
          const how = workgroupRefLabels(obj, groupId);
          if (how.length) push(type, obj, how);
        }
      } catch (err) {
        errors.push(`${type}: ${describeError(err)}`);
      }
    }));
    // Collapse a connection and a scan hit on the same object into one row.
    const merged = new Map();
    for (const u of usage) {
      const k = `${u.type}:${u.id}`;
      const prev = merged.get(k);
      merged.set(k, prev ? { ...prev, how: [...new Set([...prev.how, ...u.how])] } : u);
    }
    return {
      usage: [...merged.values()].sort((a, b) => a.type.localeCompare(b.type) || String(a.name).localeCompare(String(b.name))),
      errors,
    };
  } catch (err) {
    console.error("[workgroups] usage failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
