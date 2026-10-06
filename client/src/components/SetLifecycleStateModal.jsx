import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import toast from "react-hot-toast";
import { getIdentityLifecycleStates, moveIdentityToLifecycleState } from "../lib/sailpoint";
import { PrimaryButton, OutlineButton, SkeletonList, ErrorBox } from "./ui";

const ACTION_WORDS = { ENABLE: "Enables", DISABLE: "Disables", DELETE: "DELETES" };

// What entering a state does, as plain sentences — this is the whole point of
// the dialog: in ISC a lifecycle state isn't a label, it's a set of actions
// that run when an identity enters it (a "Terminated" state can delete
// accounts). `severe` marks the ones that can't simply be undone.
function consequences(st) {
  const out = [];
  for (const a of st.accountActions) {
    const where = a.allSources ? "accounts on all sources" : `accounts on ${a.sourceCount} source${a.sourceCount === 1 ? "" : "s"}`;
    out.push({ text: `${ACTION_WORDS[a.action] || a.action} ${where}`, severe: a.action === "DELETE" });
  }
  if (st.removesAllAccess) out.push({ text: "Removes ALL of the identity's access", severe: true });
  if (st.accessProfileCount) out.push({ text: `Grants ${st.accessProfileCount} access profile${st.accessProfileCount === 1 ? "" : "s"}`, severe: false });
  if (st.emailsManager || st.emailsOthers) out.push({ text: `Emails ${[st.emailsManager && "the manager", st.emailsOthers && "other configured recipients"].filter(Boolean).join(" and ")}`, severe: false });
  return out;
}

// Identity > Set lifecycle state. Lists the identity's profile's states with
// what each does, and moves the identity to the chosen one.
export function SetLifecycleStateModal({ identityId, identityName, onClose }) {
  const queryClient = useQueryClient();
  const [chosenId, setChosenId] = useState(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["identity-lifecycle-states", identityId],
    queryFn: () => getIdentityLifecycleStates(identityId),
  });

  const states = data?.states || [];
  const isCurrent = (st) => !!data?.current && [st.technicalName, st.name].some((n) => String(n).toLowerCase() === String(data.current).toLowerCase());
  const chosen = states.find((st) => st.id === chosenId) || null;
  const chosenSevere = chosen ? consequences(chosen).some((c) => c.severe) : false;

  const move = useMutation({
    mutationFn: () => moveIdentityToLifecycleState(identityId, chosenId),
    onSuccess: (r) => {
      toast.success(`Moved to "${r.lifecycleStateName || chosen?.name}" — ISC is carrying out that state's actions; it can take a few minutes to show.`, { duration: 8000 });
      for (const key of [["identity", identityId], ["identity-lifecycle-states", identityId], ["identity-activity", identityId], ["identities"]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !move.isPending && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-gray-100">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">Set lifecycle state</h2>
            <p className="text-xs text-gray-500 mt-0.5 truncate">{identityName}{data?.profile?.name ? ` · ${data.profile.name} profile` : ""}</p>
          </div>
          <button onClick={() => !move.isPending && onClose()} disabled={move.isPending} className="text-gray-400 hover:text-gray-600 disabled:opacity-40" title="Close"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && <SkeletonList rows={4} />}
          {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}
          {data && (
            <>
              {data.calculatedFrom && (
                <div className="border border-amber-200 bg-amber-50/60 rounded-xl px-3 py-2.5 mb-3">
                  <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5"><AlertTriangle size={13} /> This profile calculates the lifecycle state</p>
                  <p className="text-xs text-gray-700 mt-1">
                    It's derived from {data.calculatedFrom.attributeName ? <span className="font-mono">{data.calculatedFrom.attributeName}</span> : "source data"}
                    {data.calculatedFrom.sourceName ? ` on ${data.calculatedFrom.sourceName}` : ""}
                    {data.calculatedFrom.transform ? ` (transform "${data.calculatedFrom.transform}")` : ""}. A state set here takes effect now, but ISC recalculates it at the next identity refresh — if the source still says otherwise, the identity moves back. For a lasting change, change it at the source.
                  </p>
                </div>
              )}
              {states.length === 0 && <p className="text-sm text-gray-500">This identity's profile has no lifecycle states configured.</p>}
              <div role="radiogroup" aria-label="Lifecycle state" className="space-y-2">
                {states.map((st) => {
                  const current = isCurrent(st);
                  const selectable = st.enabled && !current;
                  const effects = consequences(st);
                  return (
                    <button
                      key={st.id}
                      type="button"
                      role="radio"
                      aria-checked={chosenId === st.id}
                      disabled={!selectable || move.isPending}
                      onClick={() => setChosenId(st.id)}
                      className={`w-full text-left border rounded-xl px-3 py-2.5 transition-colors ${
                        chosenId === st.id ? "border-blue-400 ring-2 ring-blue-100 bg-blue-50/40" : "border-gray-200 hover:bg-gray-50"
                      } disabled:opacity-60 disabled:hover:bg-transparent disabled:cursor-not-allowed`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-900">{st.name}</span>
                        {current && <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Current</span>}
                        {!st.enabled && <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Disabled on the profile</span>}
                        {st.identityCount != null && <span className="text-[11px] text-gray-400 ml-auto">{st.identityCount.toLocaleString()} identit{st.identityCount === 1 ? "y" : "ies"}</span>}
                      </div>
                      {st.description && <p className="text-xs text-gray-600 mt-1">{st.description}</p>}
                      {effects.length > 0 ? (
                        <ul className="mt-1.5 space-y-0.5">
                          {effects.map((c, i) => <li key={i} className={`text-xs ${c.severe ? "text-red-700 font-medium" : "text-gray-600"}`}>• {c.text}</li>)}
                        </ul>
                      ) : (
                        <p className="text-xs text-gray-400 mt-1.5">No account or access actions configured.</p>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-100">
          {chosen && (
            <p className={`text-xs mb-3 ${chosenSevere ? "text-red-700" : "text-gray-600"}`}>
              {chosenSevere
                ? `Moving ${identityName} to "${chosen.name}" runs the actions marked in red straight away — deleted accounts and removed access are not restored by moving the identity back.`
                : `Moving ${identityName} to "${chosen.name}" runs the actions listed above straight away.`}
            </p>
          )}
          <div className="flex flex-col md:flex-row gap-2">
            <PrimaryButton
              onClick={() => move.mutate()}
              loading={move.isPending}
              disabled={!chosen}
              className={`!w-auto md:flex-1 ${chosenSevere ? "!bg-red-600 hover:!bg-red-700 active:!bg-red-800" : ""}`}
            >
              {chosen ? `Move to ${chosen.name}` : "Choose a state"}
            </PrimaryButton>
            <OutlineButton onClick={onClose} disabled={move.isPending} className="!w-auto md:flex-1">Cancel</OutlineButton>
          </div>
        </div>
      </div>
    </div>
  );
}
