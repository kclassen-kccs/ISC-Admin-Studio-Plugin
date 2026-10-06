// ─── The AI workflow outline as a graph ──────────────────────────────────────
// An outline (Workflows > Create with AI) is a small flowchart: steps[0] is
// the start; an ordinary step has `next`; a decision has `branches` +
// `otherwise`; an end step (success / failure operator) has neither. This is
// the graph logic the draft flowchart needs — layout levels, and reordering.

export const OUTLINE_END_IDS = new Set(["sp:operator-success", "sp:operator-failure"]);

export const isEndStep = (st) => OUTLINE_END_IDS.has(st?.id);
export const isDecisionStep = (st) => Array.isArray(st?.branches) && st.branches.length > 0;
// One way in from the step above, one way out: the only kind that can be
// reordered without changing what the workflow decides.
const isSimpleStep = (st) => !!st && !isEndStep(st) && !isDecisionStep(st) && !!st.next;

// [{ to, label }] — label is a branch's condition, "otherwise", or null.
export function outlineEdges(st) {
  const out = [];
  if (st?.next) out.push({ to: st.next, label: null });
  for (const b of Array.isArray(st?.branches) ? st.branches : []) if (b?.next) out.push({ to: b.next, label: b.when || "if so" });
  if (st?.otherwise) out.push({ to: st.otherwise, label: "otherwise" });
  return out;
}

// Longest-path layering from the first step, so a step sits below everything
// that leads to it. The stack guard turns a loop into a back-edge rather than
// recursing forever; anything unreachable lands in a final row.
export function outlineLevels(outline) {
  const steps = Array.isArray(outline?.steps) ? outline.steps : [];
  const byName = new Map(steps.map((st) => [st.name, st]));
  const levels = new Map();
  const assign = (name, lvl, stack) => {
    if (!byName.has(name) || stack.has(name) || (levels.get(name) ?? -1) >= lvl) return;
    levels.set(name, lvl);
    stack.add(name);
    for (const e of outlineEdges(byName.get(name))) assign(e.to, lvl + 1, stack);
    stack.delete(name);
  };
  if (steps[0]) assign(steps[0].name, 0, new Set());
  const max = Math.max(-1, ...levels.values());
  for (const st of steps) if (!levels.has(st.name)) levels.set(st.name, max + 1);
  return levels;
}

// ── Reordering ──────────────────────────────────────────────────────────────
// "Move up" swaps a step with the one directly before it IN THE FLOW (not in
// the array): …→ P → A → N…  becomes  …→ A → P → N…. That is only
// well-defined when both are simple steps and P is A's sole way in — moving a
// step across a decision or a merge point would change which paths it's on,
// which is a redesign (ask the AI via Revise), not a reorder.

function inboundEdges(steps, name) {
  const out = [];
  for (const st of steps) for (const e of outlineEdges(st)) if (e.to === name) out.push({ from: st.name, viaNext: st.next === name && e.label === null });
  return out;
}

/** { ok: true, prev } or { ok: false, reason } for moving `name` up. */
export function canMoveUp(outline, name) {
  const steps = Array.isArray(outline?.steps) ? outline.steps : [];
  const step = steps.find((st) => st.name === name);
  if (!step) return { ok: false, reason: "No such step." };
  if (isEndStep(step)) return { ok: false, reason: "An end step stays at the end of its path." };
  if (isDecisionStep(step)) return { ok: false, reason: "Moving a decision changes which steps are on which branch — describe the change under “Want changes?” instead." };
  if (steps[0]?.name === name) return { ok: false, reason: "This is already the first step." };
  const inbound = inboundEdges(steps, name);
  if (inbound.length !== 1) return { ok: false, reason: "Several paths lead into this step, so there's no single step to swap it with — describe the change under “Want changes?” instead." };
  const prev = steps.find((st) => st.name === inbound[0].from);
  if (!inbound[0].viaNext || !isSimpleStep(prev)) return { ok: false, reason: "This step follows a decision — moving it above would take it off its branch. Describe the change under “Want changes?” instead." };
  if (step.next === prev.name) return { ok: false, reason: "These two steps form a loop." };
  return { ok: true, prev: prev.name };
}

/** Moving down is moving the step below it up. */
export function canMoveDown(outline, name) {
  const steps = Array.isArray(outline?.steps) ? outline.steps : [];
  const step = steps.find((st) => st.name === name);
  if (!step) return { ok: false, reason: "No such step." };
  if (!isSimpleStep(step)) return { ok: false, reason: isEndStep(step) ? "An end step stays at the end of its path." : "Moving a decision changes which steps are on which branch — describe the change under “Want changes?” instead." };
  const below = steps.find((st) => st.name === step.next);
  if (!below || !isSimpleStep(below)) return { ok: false, reason: below && isEndStep(below) ? "This is already the last step before the end." : "The next step is a decision — moving below it would put this step on one branch only. Describe the change under “Want changes?” instead." };
  const up = canMoveUp(outline, below.name);
  return up.ok ? { ok: true, next: below.name } : up;
}

// …→ P → A → N…  ⇒  …→ A → P → N…   (returns a new outline; input untouched)
function swapWithPrevious(outline, name, prevName) {
  const steps = outline.steps.map((st) => ({ ...st, branches: Array.isArray(st.branches) ? st.branches.map((b) => ({ ...b })) : st.branches }));
  const a = steps.find((st) => st.name === name);
  const p = steps.find((st) => st.name === prevName);
  const after = a.next;
  // Everything that led to P now leads to A…
  for (const st of steps) {
    if (st === p) continue;
    if (st.next === prevName) st.next = name;
    if (st.otherwise === prevName) st.otherwise = name;
    for (const b of Array.isArray(st.branches) ? st.branches : []) if (b.next === prevName) b.next = name;
  }
  // …then A, then P, then whatever followed A.
  a.next = prevName;
  p.next = after;
  // Keep the list in flow order too — steps[0] is the start.
  const ia = steps.indexOf(a);
  const ip = steps.indexOf(p);
  [steps[ia], steps[ip]] = [steps[ip], steps[ia]];
  return { ...outline, steps };
}

/** A new outline with `name` moved one place up (direction -1) or down (+1); the same outline if it can't move. */
export function moveOutlineStep(outline, name, direction) {
  if (direction < 0) {
    const up = canMoveUp(outline, name);
    return up.ok ? swapWithPrevious(outline, name, up.prev) : outline;
  }
  const down = canMoveDown(outline, name);
  return down.ok ? swapWithPrevious(outline, down.next, name) : outline;
}
