# Admin Studio AI proxy

A small stateless service that can give the Admin Studio ISC plugin access to
a model without putting an API key in the browser. The plugin builds the
prompt (from ISC data it fetches with the user's own token) and sends it
here; this service returns generated text. Nothing is stored.

**Not used by default, and not reachable from the plugin today.** The
plugin's default AI route is the tenant's own "Admin Studio AI Query" ISC
workflow (see [../isc/README.md](../isc/README.md)), which needs no service
outside ISC. This proxy is the fallback of the "Direct from this browser"
route, and ISC's plugin content security policy currently blocks every
outbound call from the plugin iframe, so a build pointed at the proxy
reports "ISC blocked the call" until SailPoint allows a connect-src origin.
It is kept, with its tests, for when that changes.

```
POST /v1/generate
Authorization: Bearer <ISC access token from the App Shell>
X-ISC-Base-Url: https://<tenant>.api.identitynow.com
{ "prompt": "...", "maxTokens": 300, "strong": false }
-> { "text": "..." }
```

## Auth

The caller's token is proven genuine by calling the caller's own tenant with it
(`ISC_VALIDATE_PATH`, default `GET /v3/public-identities-config`; a 401 rejects,
a 403 still counts as authenticated). The base URL is checked against
`ALLOWED_BASE_URL_REGEX` / `ALLOWED_BASE_URLS` first, so the proxy never calls
an arbitrary host. Results are cached for 60 s. Requests are rate limited to 60
per minute per tenant.

## Run

```
cd ai-proxy && npm install && cp .env.example .env   # fill in a provider
node --env-file=.env index.js
npm test
```

Set `ANTHROPIC_API_KEY`, or `AI_PROVIDER=bedrock` to use the host's IAM role.

## Wire up the plugin (when ISC allows it)

1. Build the client with `REACT_APP_AI_PROXY_URL=https://<proxy-host>`.
2. The plugin manifest would have to allow that origin for connect-src;
   today `sp-ui-plugin.json` accepts only script-src and style-src policies,
   so this step is not yet possible.
3. Users pick "Direct from this browser" under Studio Settings → Preferences
   → AI Route; without a key typed in the tab, the direct route falls back
   to this proxy.

Without `REACT_APP_AI_PROXY_URL` and without a key, the direct route says
"AI isn't configured for the direct route" and everything else is
unaffected; the workflow route keeps working either way.
