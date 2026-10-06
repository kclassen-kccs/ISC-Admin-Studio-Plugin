# Admin Studio AI proxy

A small stateless service that gives the Admin Studio ISC plugin access to a
model without putting an API key in the browser. The plugin builds the prompt
(from ISC data it fetches with the user's own token) and sends it here; this
service returns generated text. Nothing is stored.

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

## Wire up the plugin

1. Build the client with `REACT_APP_AI_PROXY_URL=https://<proxy-host>`.
2. Allow that origin in `sp-ui-plugin.json` (`contentSecurityPolicies`, connect-src),
   otherwise the iframe blocks the request.

Without `REACT_APP_AI_PROXY_URL` the AI buttons fail with a clear
"AI isn't configured" message and everything else is unaffected.
