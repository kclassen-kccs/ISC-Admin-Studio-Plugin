// A tenant is registered either as a SHORT NAME ("acme", on the default
// identitynow-demo.com domain) or as a FULL HOST — anything containing a "."
// — which is used exactly as typed with only https:// added
// ("acme.api.identitynow.com"). These mirror the server's
// normalizeTenantInput / tenantApiHost / tenantUiHost; the server validates.

const DEFAULT_TENANT_DOMAIN = "identitynow-demo.com";

export const isFullHostTenant = (tenant) => String(tenant || "").includes(".");

/**
 * What someone typed or pasted -> the tenant key: lowercased, with a pasted
 * https://, path, port or trailing dot dropped. A host on the default domain
 * collapses to its short name, so existing registrations keep resolving;
 * any other host is kept whole.
 */
export function normalizeTenantInput(raw) {
  let t = String(raw || "").trim().toLowerCase();
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.+$/, "");
  const m = t.match(/^([a-z0-9][a-z0-9-]{0,62})(?:\.api)?\.identitynow-demo\.com$/);
  return m ? m[1] : t;
}

/** True when the tenant lives on the identitynow-demo.com domain (every short-name tenant does). */
export function isDemoDomainTenant(tenant) {
  if (!tenant) return false;
  return tenantApiHost(tenant).toLowerCase().endsWith(`.${DEFAULT_TENANT_DOMAIN}`);
}

/** The host API calls go to — a full-host tenant IS that host. */
export function tenantApiHost(tenant) {
  return isFullHostTenant(tenant) ? String(tenant) : `${tenant}.api.${DEFAULT_TENANT_DOMAIN}`;
}

/** The tenant's web UI host ("Manage in ISC" links): the API host without its ".api" label. */
export function tenantUiHost(tenant) {
  return isFullHostTenant(tenant) ? String(tenant).replace(/\.api\./, ".") : `${tenant}.${DEFAULT_TENANT_DOMAIN}`;
}
