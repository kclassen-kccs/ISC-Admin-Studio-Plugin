import { useQuery } from "@tanstack/react-query";
import { getLdapStatus } from "../lib/sailpoint";

// A small SailPoint "sail" mark, for marking things that act on ISC itself
// (e.g. the ISC Admins source). Sized like a lucide icon. `crossed` draws a
// red line through it — used when the action behind it isn't available.
export function SailPointIcon({ size = 16, className = "", crossed = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g opacity={crossed ? 0.45 : 1}>
        <path d="M12.5 2 L21 19 L12.5 19 Z" fill="#0071CE" />
        <path d="M11 6 L11 19 L4 19 Z" fill="#CC27B0" />
        <path d="M3 21 H21" stroke="#0033A1" strokeWidth="2" strokeLinecap="round" />
      </g>
      {crossed && <path d="M3 3 L21 21" stroke="#DC2626" strokeWidth="2.5" strokeLinecap="round" />}
    </svg>
  );
}

// Sources the "Add from LDAP" action applies to.
export const isIscAdminsSource = (source) => String(source?.name || "").trim().toLowerCase() === "isc admins";

// Whether the server can reach its domain controller right now (cached
// server-side for a minute; re-checked here every minute too).
export function useLdapReachability(enabled = true) {
  return useQuery({
    queryKey: ["ldap-status"],
    queryFn: getLdapStatus,
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: enabled ? 60 * 1000 : false,
    retry: false,
  });
}

/**
 * "Add SailPoint User" — the ISC Admins source's Accounts-tab pill, styled
 * like its Generate Data neighbour. Hidden while reachability is being
 * checked; active (opens Add from LDAP) when the DC is reachable; when it
 * isn't, disabled with the SailPoint logo crossed out and a generic
 * "not currently available" tooltip (no server name).
 */
export function AddSailPointUserPill({ onOpen }) {
  const status = useLdapReachability();
  if (!status.data) return null;
  const { reachable, host } = status.data;
  return (
    <button
      type="button"
      onClick={reachable ? onOpen : undefined}
      disabled={!reachable}
      title={reachable ? `Find a user in ${host} and add them to this source` : "This option is not currently available."}
      className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border transition-colors ${
        reachable
          ? "border-gray-200 text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          : "border-gray-200 text-gray-400 cursor-not-allowed"
      }`}
    >
      <SailPointIcon size={14} crossed={!reachable} />
      Add SailPoint User
    </button>
  );
}
