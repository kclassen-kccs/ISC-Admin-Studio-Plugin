#!/usr/bin/env node
/*
 * Registers the sign-in OAuth client in a tenant.
 *
 * OAuth clients are tenant-scoped, so every tenant that should support
 * authorization-code sign-in needs its own. Run this once per tenant, then add
 * the printed entry to the SP_OAUTH_CLIENTS registry.
 *
 * Usage:
 *   node scripts/register-oauth-client.js <tenant> <admin-client-id> <admin-client-secret>
 *
 * The admin credentials are a Personal Access Token for THAT tenant, used only
 * to create the client. They are not stored anywhere.
 *
 * Registration deletes-and-recreates any existing client with the same name,
 * so two deployments sharing a name fight over one client — e.g. running
 * this against the same tenant a server is already using will break it. Set
 * SP_SIGNIN_CLIENT_NAME (must match the server's own env var) to give a
 * second deployment — typically local dev — its own independent client.
 */
const axios = require("axios");

const CLIENT_NAME = process.env.SP_SIGNIN_CLIENT_NAME || "identity-app-user-login";

const REDIRECT_URIS = [
  "http://localhost:3000/auth/callback",
  "https://adminstudio.vercel.app/auth/callback",
  "https://adminstudio.kccs.net/auth/callback",
  "com.kccs.identitysecurity://auth/callback",
];

const [tenantArg, adminId, adminSecret] = process.argv.slice(2);

if (!tenantArg || !adminId || !adminSecret) {
  console.error("Usage: node scripts/register-oauth-client.js <tenant> <admin-client-id> <admin-client-secret>");
  console.error("(set SP_SIGNIN_CLIENT_NAME to register under a different name than the default)");
  process.exit(1);
}
const tenant = tenantArg.trim().toLowerCase();

async function main() {
  const api = `https://${tenant}.api.identitynow-demo.com`;

  const token = (await axios.post(
    `${api}/oauth/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: adminId,
      client_secret: adminSecret,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  )).data.access_token;

  const auth = { Authorization: `Bearer ${token}` };

  // Reuse an existing client rather than piling up duplicates on re-runs.
  const existing = (await axios.get(`${api}/beta/oauth-clients`, { headers: auth })).data
    .find((c) => c.name === CLIENT_NAME);
  if (existing) {
    console.error(
      `A client named "${CLIENT_NAME}" already exists in ${tenant} (id ${existing.id}).\n` +
      "Its secret is only shown at creation, so if you don't have it, delete that client and re-run:\n" +
      `  curl -X DELETE ${api}/beta/oauth-clients/${existing.id} -H "Authorization: Bearer <token>"`
    );
    process.exit(2);
  }

  const created = (await axios.post(
    `${api}/beta/oauth-clients`,
    {
      name: CLIENT_NAME,
      description: "Admin Studio",
      businessName: "KCCS",
      homepageUrl: "https://adminstudio.vercel.app",
      type: "CONFIDENTIAL",
      grantTypes: ["AUTHORIZATION_CODE", "REFRESH_TOKEN"],
      redirectUris: REDIRECT_URIS,
      accessType: "OFFLINE",
      enabled: true,
      internal: false,
      strongAuthSupported: true,
      claimsSupported: true,
      accessTokenValiditySeconds: 3600,
      refreshTokenValiditySeconds: 86400,
    },
    { headers: { ...auth, "Content-Type": "application/json" } }
  )).data;

  if (!created.secret) {
    console.error("Client was created but no secret was returned — delete it and retry.");
    process.exit(3);
  }

  console.log(`\nRegistered in ${tenant} (client id ${created.id}).`);
  console.log("Add this to SP_OAUTH_CLIENTS (merge with any existing entries):\n");
  console.log(JSON.stringify({ [tenant]: { clientId: created.id, clientSecret: created.secret } }, null, 2));
  console.log("\nThe secret is shown once only — save it now.");
}

main().catch((err) => {
  console.error("Failed:", err.response?.status || "", err.response?.data || err.message);
  process.exit(1);
});
