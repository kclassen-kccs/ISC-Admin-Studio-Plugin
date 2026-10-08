# ISC tenant assets

Things the plugin expects to find on the tenant it runs in.

## Admin Studio AI Query (workflow)

The plugin's default way to reach Claude. The plugin iframe may not call
api.anthropic.com itself (ISC's plugin content security policy), so an ISC
workflow makes the call on its behalf:

```
plugin ──test execution (user's session)──▶ workflow "Admin Studio AI Query"
         input { url, request }                HTTP Request: POST {{$.trigger.url}}
                                               auth: parameter "Admin Studio AI Key" → x-api-key
                                               body: request, passed through unchanged
plugin ◀──execution history: statusCode + body (the Claude Message JSON)──
```

| Piece | Type | Holds |
|---|---|---|
| Parameter `Admin Studio AI Connection` | 2.4 Web App | `url` = `https://api.anthropic.com/v1/messages`. The plugin reads this public field and passes it to the workflow, since an HTTP Request step takes a parameter for authentication but not for its URL. |
| Parameter `Admin Studio AI Key` | 1.3 HTTP Custom Authorization | `headerName` = `x-api-key`; `headerValue` (private) = the Anthropic API key. Created with a placeholder value; set the real key in ISC. Only the workflow engine ever reads it. |
| Workflow `Admin Studio AI Query` | External Trigger | One HTTP Request step bound to the key parameter, then End Step - Success. [Definition](admin-studio-ai-query.workflow.json). |

Create all three on a tenant with:

```
SAIL_BASE_URL=https://<tenant>.api.identitynow.com SAIL_CLIENT_ID=… SAIL_CLIENT_SECRET=… \
  node scripts/setup-ai-workflow.mjs
```

The script is safe to re-run and never takes the key itself. Afterwards, open
Parameter Storage in ISC (or Browse → Parameters in the plugin) and replace the
placeholder header value of "Admin Studio AI Key" with the real key.

**Keep the workflow disabled.** Its External Trigger's execute endpoint accepts
only the trigger's own OAuth client, whose secret would have to live in the
browser, so the plugin runs the workflow through the test endpoint with the
signed-in user's session instead. ISC runs the steps for real in that mode but
refuses it for an enabled workflow; the plugin says so if it finds it enabled.

The route is chosen per user on Studio Settings → Preferences → AI Route. The
"Direct from this browser" route (saved Anthropic key, `lib/aiProxy.js`) is
kept for when ISC allows plugins to make outbound calls.
