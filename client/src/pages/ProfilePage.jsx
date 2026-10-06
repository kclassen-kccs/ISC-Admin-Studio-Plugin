import { useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { useAuth } from "../hooks/useAuth";
import { TopBar } from "../components/TopBar";
import { getCredentials } from "../lib/sailpoint";
import { Key, Globe, Code, Tag, ChevronRight } from "lucide-react";
import pkg from "../../package.json";
import { tenantUiHost } from "../lib/tenantHost";

const APP_VERSION = pkg.version;

export default function ProfilePage() {
  const { session } = useAuth();
  const [showClaims, setShowClaims] = useState(false);
  const navigate = useNavigate();
  const creds = getCredentials();

  const displayName = session?.identity?.displayName || session?.identity?.username || "Admin";

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title="Profile" onBack={() => navigate(-1)} />
      <div className="flex-1 overflow-y-auto pb-24">
        {/* Avatar block */}
        <div className="flex flex-col items-center py-8 border-b border-gray-100">
          <div className="w-20 h-20 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-2xl font-bold mb-3">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <p className="text-base font-semibold text-gray-900">{displayName}</p>
          <p className="text-sm text-gray-500 mt-0.5">{tenantUiHost(creds?.tenant)}</p>
        </div>

        {/* Session info */}
        <div className="px-4 pt-5">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Session</p>
          <div className="border border-gray-100 rounded-2xl overflow-hidden">
            {[
              { icon: Globe, label: "Tenant", value: `${tenantUiHost(creds?.tenant)}` },
              { icon: Key, label: "Signed in as", value: session?.identity?.username || "—" },
              { icon: Code, label: "SailPoint ISC API version", value: "v2026" },
              { icon: Tag, label: "Application version", value: `v${APP_VERSION}` },
            ].map(({ icon: Icon, label, value }, i, arr) => (
              <div key={label} className={`flex items-center gap-3 px-4 py-3.5 ${i < arr.length - 1 ? "border-b border-gray-100" : ""}`}>
                <Icon size={16} className="text-gray-400 flex-shrink-0" />
                <span className="text-sm text-gray-500 flex-1">{label}</span>
                <span className="text-sm font-medium text-gray-900 text-right break-all max-w-[55%]">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Decoded OAuth token — last, since it's a diagnostic detail rather
            than something most visits to this screen need. */}
        {session?.claims && (
          <div className="px-4 pt-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                OAuth token (decoded)
              </p>
            </div>
            <div className="border border-gray-100 rounded-2xl overflow-hidden">
              <button
                onClick={() => setShowClaims((v) => !v)}
                className="w-full flex items-center gap-3 px-4 py-3.5"
                aria-expanded={showClaims}
              >
                <Key size={16} className="text-gray-400 flex-shrink-0" />
                <span className="text-sm text-gray-500 flex-1 text-left">
                  {showClaims ? "Hide claims" : "Show claims"}
                </span>
                {/* strong_auth is the one claim worth seeing without expanding —
                    it's what decides whether admin calls succeed. */}
                <span
                  className={`text-xs font-medium ${
                    session.claims.strong_auth === true ? "text-green-700" : "text-red-600"
                  }`}
                >
                  strong_auth {String(session.claims.strong_auth === true)}
                </span>
                <ChevronRight
                  size={16}
                  className={`text-gray-300 flex-shrink-0 transition-transform ${showClaims ? "rotate-90" : ""}`}
                />
              </button>
            </div>
            {showClaims && (
            <div className="border border-gray-100 rounded-2xl overflow-hidden mt-2">
              {Object.entries(session.claims)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value], i, arr) => {
                  // exp/iat are unix seconds — show the actual time too.
                  const isTime = key === "exp" || key === "iat" || key === "nbf";
                  // scope/authorities decide what this token can actually
                  // do — worth reading as a list, not a long comma-joined
                  // (or, for scope, space-joined per the OAuth spec) line.
                  const isScopeList = key === "scope" || key === "authorities";
                  const scopeItems = isScopeList
                    ? Array.isArray(value)
                      ? value
                      : String(value).split(/\s+/).filter(Boolean)
                    : null;
                  const shown = Array.isArray(value)
                    ? value.join(", ")
                    : typeof value === "object" && value !== null
                    ? JSON.stringify(value)
                    : String(value);
                  return (
                    <div
                      key={key}
                      className={`flex items-start gap-3 px-4 py-3 ${i < arr.length - 1 ? "border-b border-gray-100" : ""}`}
                    >
                      <span className="text-xs font-mono text-gray-500 flex-shrink-0 w-32 break-all">{key}</span>
                      {scopeItems ? (
                        <span className="text-xs font-mono text-gray-900 flex-1 text-right space-y-0.5">
                          {scopeItems.map((item, j) => (
                            <span key={j} className="block break-all">{item}</span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-xs font-mono text-gray-900 flex-1 break-all text-right">
                          {shown}
                          {isTime && Number(value) > 0 && (
                            <span className="block text-gray-400 font-sans">
                              {new Date(Number(value) * 1000).toLocaleString()}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
            )}
            {showClaims && (
              <p className="text-xs text-gray-400 mt-2 leading-relaxed">
                Claims only — the access token itself stays on the server.
                {session.claims.strong_auth === false && (
                  <span className="block text-red-600 mt-1">
                    strong_auth is false, so SailPoint refuses admin API calls (403).
                  </span>
                )}
              </p>
            )}
          </div>
        )}

        <p className="text-xs text-gray-400 text-center px-6 mt-5 leading-relaxed">
          Credentials are held in memory only for this session. Signing out clears them completely.
        </p>
      </div>
    </div>
  );
}
