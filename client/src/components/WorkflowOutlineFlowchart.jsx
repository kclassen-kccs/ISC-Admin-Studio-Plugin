import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, ChevronDown, Zap } from "lucide-react";
import { outlineEdges, outlineLevels, isDecisionStep, isEndStep, canMoveUp, canMoveDown, moveOutlineStep } from "../lib/workflowOutline";

// The AI's proposed workflow as a flowchart — the same picture the saved
// workflow's Workflow tab draws (layered top-down, the same colours per kind
// of step, labelled branch arrows), but built from HTML boxes rather than
// fixed-size SVG ones: a draft is reviewed by reading what each step WILL DO,
// so every box carries its full description at whatever height that takes,
// plus the controls to move it. The arrows are an SVG layer drawn from the
// boxes' measured positions.

// Same palette as WorkflowDetailPage's FLOW_COLORS, as classes.
const KIND_STYLE = {
  trigger: "bg-gray-100 border-gray-300 text-gray-700",
  decision: "bg-violet-50 border-violet-200 text-violet-800",
  action: "bg-teal-50 border-teal-200 text-teal-800",
  success: "bg-gray-100 border-gray-300 text-gray-700",
  failure: "bg-red-50 border-red-200 text-red-700",
};
const kindOf = (st) => (isDecisionStep(st) ? "decision" : isEndStep(st) ? (st.id === "sp:operator-failure" ? "failure" : "success") : "action");

const TRIGGER = "__trigger__";
const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");

function MoveButton({ icon: Icon, can, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!can.ok}
      title={can.ok ? label : can.reason}
      aria-label={label}
      className="w-6 h-6 flex items-center justify-center rounded-md border border-black/10 bg-white/70 hover:bg-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
    >
      <Icon size={14} />
    </button>
  );
}

// `onChange(nextOutline)` makes it editable (reorder); omit it for read-only.
export function WorkflowOutlineFlowchart({ outline, onChange }) {
  const steps = useMemo(() => (Array.isArray(outline?.steps) ? outline.steps : []), [outline]);
  const levels = useMemo(() => outlineLevels(outline), [outline]);

  // Rows of the chart: the trigger alone on top, then one row per level.
  const rows = useMemo(() => {
    const byLevel = new Map();
    for (const st of steps) {
      const lvl = levels.get(st.name) ?? 0;
      if (!byLevel.has(lvl)) byLevel.set(lvl, []);
      byLevel.get(lvl).push(st);
    }
    return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  }, [steps, levels]);

  const edges = useMemo(() => {
    const out = steps[0] ? [{ from: TRIGGER, to: steps[0].name, label: null }] : [];
    for (const st of steps) for (const e of outlineEdges(st)) out.push({ from: st.name, ...e });
    return out;
  }, [steps]);

  // Measure every box relative to the chart, then draw the arrows from that.
  const chartRef = useRef(null);
  const boxRefs = useRef(new Map());
  const [boxes, setBoxes] = useState(null);
  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (!chart) return undefined;
    const measure = () => {
      const origin = chart.getBoundingClientRect();
      const next = new Map();
      for (const [name, el] of boxRefs.current) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        next.set(name, { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
      }
      setBoxes({ map: next, width: origin.width, height: origin.height });
    };
    measure();
    // Text wraps differently at every width, so every resize re-measures.
    const observer = new ResizeObserver(measure);
    observer.observe(chart);
    return () => observer.disconnect();
  }, [outline]);

  const setBoxRef = (name) => (el) => {
    if (el) boxRefs.current.set(name, el);
    else boxRefs.current.delete(name);
  };

  return (
    <div ref={chartRef} className="relative">
      {boxes && (
        <svg className="absolute inset-0 pointer-events-none" width={boxes.width} height={boxes.height} aria-hidden="true">
          <defs>
            <marker id="wf-outline-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M2 1L8 5L2 9" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const from = boxes.map.get(e.from);
            const to = boxes.map.get(e.to);
            if (!from || !to) return null;
            const x1 = from.x + from.w / 2;
            const y1 = from.y + from.h;
            const x2 = to.x + to.w / 2;
            const y2 = to.y;
            const forward = y2 > y1;
            // A step that leads back up (a loop) swings out past the right
            // edge of the boxes instead of cutting through them.
            const d = forward
              ? `M ${x1} ${y1} C ${x1} ${y1 + 22}, ${x2} ${y2 - 22}, ${x2} ${y2}`
              : `M ${from.x + from.w} ${from.y + from.h / 2} C ${boxes.width - 4} ${from.y + from.h / 2}, ${boxes.width - 4} ${to.y - 28}, ${x2} ${to.y}`;
            return (
              <g key={i}>
                <path d={d} fill="none" stroke="#9ca3af" strokeWidth="1.2" markerEnd="url(#wf-outline-arrow)" />
                {e.label && (
                  <text
                    x={forward ? (x1 + x2) / 2 : boxes.width - 28} y={forward ? (y1 + y2) / 2 : (from.y + to.y) / 2}
                    textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#6b7280"
                    className="wf-outline-edge-label" strokeWidth="4" paintOrder="stroke" style={{ fontFamily: "inherit" }}
                  >
                    {truncate(e.label, 30)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}

      <div className="relative flex flex-col items-center gap-11">
        <div ref={setBoxRef(TRIGGER)} className={`w-full max-w-sm border rounded-xl px-3 py-2.5 ${KIND_STYLE.trigger}`}>
          <p className="text-xs font-semibold flex items-center gap-1.5"><Zap size={13} /> Starts when: {outline.trigger?.name || outline.trigger?.id}</p>
          {outline.trigger?.why && <p className="text-xs text-gray-600 mt-1">{outline.trigger.why}</p>}
          {outline.trigger?.filter && <p className="text-xs text-gray-700 mt-1"><span className="font-medium">Only when:</span> {outline.trigger.filter}</p>}
          <p className="font-mono text-[10px] opacity-60 mt-1">{outline.trigger?.id}</p>
        </div>

        {rows.map((row, r) => (
          <div key={r} className="w-full flex items-start justify-center gap-3">
            {row.map((st) => {
              const kind = kindOf(st);
              return (
                <div key={st.name} ref={setBoxRef(st.name)} className={`flex-1 min-w-0 max-w-sm border rounded-xl px-3 py-2.5 ${KIND_STYLE[kind]}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold break-words">{st.name}</p>
                    {onChange && kind === "action" && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <MoveButton icon={ChevronUp} can={canMoveUp(outline, st.name)} label={`Move "${st.name}" earlier`} onClick={() => onChange(moveOutlineStep(outline, st.name, -1))} />
                        <MoveButton icon={ChevronDown} can={canMoveDown(outline, st.name)} label={`Move "${st.name}" later`} onClick={() => onChange(moveOutlineStep(outline, st.name, 1))} />
                      </div>
                    )}
                  </div>
                  {st.purpose && <p className="text-xs text-gray-700 mt-1 break-words">{st.purpose}</p>}
                  {/* A decision spells its exits out in full — the arrow labels are clipped. */}
                  {kind === "decision" && (
                    <ul className="mt-1.5 space-y-0.5">
                      {st.branches.map((b, i) => <li key={i} className="text-xs text-gray-700"><span className="font-medium">If</span> {b.when} <span className="text-gray-400">→</span> {b.next}</li>)}
                      {st.otherwise && <li className="text-xs text-gray-700"><span className="font-medium">Otherwise</span> <span className="text-gray-400">→</span> {st.otherwise}</li>}
                    </ul>
                  )}
                  <p className="font-mono text-[10px] opacity-60 mt-1">{st.id}</p>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
