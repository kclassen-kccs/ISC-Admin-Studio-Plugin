// Which failed audit events are worth simply retrying.
//
// ISC events carry no retry flag, so this classifies by the error the event
// recorded: a failure is "retryable" when its text shows a TRANSIENT cause —
// timeouts, dropped/refused connections, 429/502/503/504, "temporarily
// unavailable", throttling, deadlocks — i.e. trying again could succeed
// without anyone changing anything. Failures that need a fix first (access
// denied, bad credentials, invalid configuration, not found) are not, even if
// they also mention something transient-sounding.

const FAILED_STATUSES = new Set(["FAILED", "ERROR", "INCOMPLETE"]);

export function isFailedEvent(e) {
  return FAILED_STATUSES.has(String(e?.status || "").toUpperCase());
}

const TRANSIENT = [
  [/\btimed?[\s-]?out\b|\btimeout\b|ETIMEDOUT|ESOCKETTIMEDOUT|read time ?out|deadline exceeded/i, "timeout"],
  [/ECONNRESET|connection (was )?reset|socket hang ?up|broken pipe/i, "connection reset"],
  [/ECONNREFUSED|connection refused/i, "connection refused"],
  [/EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|network (is )?unreachable|host unreachable/i, "network unreachable"],
  [/\b429\b|too many requests|rate[\s-]?limit|throttl/i, "rate limited"],
  [/\b50[234]\b|bad gateway|service unavailable|gateway time ?out/i, "server unavailable (5xx)"],
  [/temporar(il)?y unavailable|temporary (failure|error)|try again( later)?|please retry|retry later/i, "temporarily unavailable"],
  [/deadlock|lock wait timeout|could not obtain lock|lock acquisition/i, "lock contention"],
];

const NEEDS_FIX = /access ?denied|not authori[sz]ed|unauthori[sz]ed|forbidden|\b40[13]\b|invalid ?(password|credentials?|client|grant|token)|LOGIN_FAILED|authentication failed|permission|not permitted|does not exist|not found|\b404\b|invalid (configuration|parameter|argument|request)|validation (error|failed)|schema/i;

function eventText(e) {
  const parts = [e?.name, e?.technicalName, e?.action, e?.stack];
  for (const v of [e?.errors, e?.warnings, e?.details, e?.attributes]) {
    if (v != null) parts.push(typeof v === "string" ? v : JSON.stringify(v));
  }
  return parts.filter(Boolean).join(" \n ");
}

/** The transient signal that makes a failed event retryable, or null. */
export function retryableReason(e) {
  if (!isFailedEvent(e)) return null;
  const text = eventText(e);
  if (NEEDS_FIX.test(text)) return null;
  for (const [re, label] of TRANSIENT) if (re.test(text)) return label;
  return null;
}
