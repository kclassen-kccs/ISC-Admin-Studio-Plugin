/**
 * ported/scanJobs.js
 * Shared plumbing for the Insights scans (role, segment, skeleton, role
 * evaluation, certification planning, attribute sync, DL ...). On the old
 * server each scan was a record in its own store plus an async runner that
 * kept patching that record until it finished. In the plugin the runner is
 * the same, it just runs in the page: a scan keeps going while the tab is
 * open and is lost on a full reload, which is why a "running" record with
 * no live job is marked failed the next time its store is read.
 */

import { recordStore } from "../store";

// store name -> Set of ids with a live runner in this page.
const live = new Map();
// store name -> Set of ids asked to stop (runners poll isCancelled()).
const cancelled = new Map();

const setFor = (map, store) => {
  if (!map.has(store)) map.set(store, new Set());
  return map.get(store);
};

/** Shallow-merges `patch` into the stored record. */
export async function patchRecord(store, id, patch) {
  const s = recordStore(store);
  const next = { ...((await s.get(id)) || {}), ...patch };
  await s.put(id, next);
  return next;
}

/**
 * Runs `runner()` in the background for record `id` of `store`. The runner
 * owns its own status updates (as the server's did); this only guarantees
 * the record never stays "running" after an uncaught failure, and tracks
 * which ids are alive so an interrupted one can be told apart later.
 */
export function startJob(store, id, runner) {
  const ids = setFor(live, store);
  ids.add(id);
  Promise.resolve()
    .then(runner)
    .catch(async (err) => {
      console.error(`[${store}] ${id} failed:`, err?.response?.data || err?.message || err);
      try {
        const current = await recordStore(store).get(id);
        if (current && current.status === "running") {
          await patchRecord(store, id, {
            status: "failed",
            error: err?.response?.data?.error || err?.message || "Scan failed.",
            completedAt: new Date().toISOString(),
          });
        }
      } catch {
        // nothing else to do
      }
    })
    .finally(() => {
      ids.delete(id);
      setFor(cancelled, store).delete(id);
    });
}

export function isJobLive(store, id) {
  return setFor(live, store).has(id);
}

/** Asks a running job to stop; runners check isCancelled() between steps. */
export function requestCancel(store, id) {
  setFor(cancelled, store).add(id);
}

export function isCancelled(store, id) {
  return setFor(cancelled, store).has(id);
}

/**
 * Marks "running" records that have no live runner in this page as failed —
 * they were interrupted by a reload or belong to another tab.
 */
export async function failInterrupted(store) {
  const s = recordStore(store);
  const all = await s.all();
  for (const [id, rec] of Object.entries(all)) {
    if (rec?.status === "running" && !isJobLive(store, id)) {
      await s.put(id, {
        ...rec,
        status: "failed",
        error: rec.error || "Interrupted: the page was reloaded before the scan finished.",
        completedAt: rec.completedAt || new Date().toISOString(),
      });
    }
  }
}

/** A new id in the server's `<prefix>_<ms>_<rand>` shape. */
export function newScanId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
