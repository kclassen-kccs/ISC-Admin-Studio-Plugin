import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { setCredentials, clearCredentials } from "../lib/sailpoint";
import { whenPluginReady } from "../lib/pluginSdk";

// There is no sign-in: the ISC App Shell has already authenticated the user
// and hands the plugin a scoped token over postMessage (see lib/pluginSdk).
// This provider only turns the handshake context into the `session` shape the
// rest of the app reads.

const AuthContext = createContext(null);

function sessionFromContext(ctx) {
  const user = ctx?.user || {};
  const tenant = ctx?.tenant?.org || ctx?.tenant?.name || null;
  const username = user.uid || user.username || user.email || user.id || "";
  return {
    tenant,
    identity: {
      id: user.id || null,
      username,
      displayName: user.displayName || user.name || username,
    },
    // The scoped token is minted by the App Shell for the signed-in user, so
    // there is no separate strong-auth / elevation state to track.
    strongAuth: true,
    claims: null,
    elevated: false,
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    whenPluginReady()
      .then((ctx) => {
        if (cancelled) return;
        const next = sessionFromContext(ctx);
        setCredentials({ tenant: next.tenant, identityId: next.identity.id });
        setSession(next);
      })
      .catch((err) => {
        if (cancelled) return;
        clearCredentials();
        setError(err?.message || "Could not connect to the Identity Security Cloud App Shell.");
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Session lifetime belongs to ISC; there is nothing to sign out of here.
  const logout = useCallback(() => {}, []);

  return (
    <AuthContext.Provider value={{ session, restoring, error, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
