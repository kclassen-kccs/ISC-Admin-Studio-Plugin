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
| Parameter `Admin Studio AI Key` | 1.3 HTTP Custom Authorization | `headerName` = `x-api-key`; `headerValue` (private) = the Anthropic API key, encrypted in the browser to SailPoint's enclave. Only the workflow engine ever reads it. |
| Workflow `Admin Studio AI Query` | External Trigger | One HTTP Request step bound to the key parameter, then End Step - Success. [Definition](../client/src/lib/aiWorkflow.template.json). |

The plugin creates all three itself: on Studio Settings → Preferences, saving
an Anthropic API key writes it into the key parameter and creates whatever is
missing (`client/src/lib/aiSetup.js`). Saving a new key later updates the
parameter and checks the connection parameter and workflow are still there,
re-binding or re-disabling the workflow if it drifted.

They can also be created from a terminal, without the key, with:

```
SAIL_BASE_URL=https://<tenant>.api.identitynow.com SAIL_CLIENT_ID=… SAIL_CLIENT_SECRET=… \
  node scripts/setup-ai-workflow.mjs
```

The script is safe to re-run. It leaves a placeholder in "Admin Studio AI
Key"; replace it in ISC Parameter Storage, or save the key on Preferences.

**Keep the workflow disabled.** Its External Trigger's execute endpoint accepts
only the trigger's own OAuth client, whose secret would have to live in the
browser, so the plugin runs the workflow through the test endpoint with the
signed-in user's session instead. ISC runs the steps for real in that mode but
refuses it for an enabled workflow; the plugin says so if it finds it enabled.

The route is chosen per user on Studio Settings → Preferences → AI Route. The
"Direct from this browser" route (`lib/aiProxy.js`, a key typed on
Preferences and held in memory for the open tab only) is kept for when ISC
allows plugins to make outbound calls. The plugin persists the key nowhere;
ISC Parameter Storage is its only home.
