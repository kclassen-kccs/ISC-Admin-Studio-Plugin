# App Store Listing — Admin Studio

Copy for each App Store Connect field. Character limits noted per field;
counts verified against the limit.

---

## App Name (30 char limit)

 Admin Studio

*(12 chars. Deliberately avoids "SailPoint" in the name — Apple's metadata
rules are strict about third-party trademarks in names/subtitles, and
SailPoint compatibility is stated in the description instead.)*

## Subtitle (30 char limit)

 Identity governance, mobile

*(27 chars. Alternate: "Role engineering on the go" — 26.)*

## Promotional Text (170 char limit — editable without review)

 Mine roles from real access data, evaluate them against who holds what
 today, and manage SOD exceptions — from your phone, signed in with your
 own SailPoint account.

*(168 chars)*

## Description (4000 char limit)

 Admin Studio brings identity governance out of the browser tab and into
 your pocket. Built for role engineers, IAM administrators, and identity
 consultants working with SailPoint Identity Security Cloud (ISC), it
 turns the slow parts of role management — discovering candidate roles,
 checking whether existing roles still match reality, cleaning up
 separation-of-duties conflicts — into something you can do anywhere.

 ROLE MINING
 Scan your identity population and let Admin Studio discover candidate
 roles from the access people actually hold. Peer groups are built from
 your tenant's own attribute data (a built-in Schema Analysis picks the
 attributes that split your population best), entitlements are grouped by
 real commonality, and every proposed role can be created in ISC with one
 tap — including membership criteria, Common Access flagging, and
 AI-generated role descriptions grounded in the role's actual facts.

 ROLE EVALUATION
 Roles drift. Admin Studio evaluates every role against who holds what
 today and tells you which ones are fine, which need updating, and which
 contain separation-of-duties violations — with a guided repair flow,
 time-boxed SOD mitigations, and a dashboard that shows role health at a
 glance. Schedule recurring evaluations and open the app to fresh results.

 A FULL ISC BROWSER
 Identities, roles, access profiles, applications, sources, and
 entitlements — searchable, filterable, and actionable. Enable or disable
 identities in bulk, grant or revoke access, edit role membership criteria,
 and drill from any identity down to the individual entitlement.

 BACKUP & RESTORE
 Export role definitions and offline-source account data as portable
 backups (per-file or a single ZIP), restore them later, and print or
 email polished PDF reports of scans, evaluations, and role definitions.

 BUILT FOR ENTERPRISE SIGN-IN
 You sign in on SailPoint's own hosted login page — SSO and MFA work
 exactly as your organization configured them, and this app never sees or
 stores your password. Your access mirrors your ISC permissions: what you
 can do in ISC is what you can do here, nothing more.

 REQUIREMENTS
 Admin Studio requires a SailPoint Identity Security Cloud tenant and a
 one-time OAuth client registration performed by your administrator. It is
 an independent product and is not affiliated with or endorsed by
 SailPoint Technologies.

*(~2,300 chars — comfortable headroom under the 4,000 limit)*

## Keywords (100 char limit, comma-separated)

 sailpoint,identity,IAM,IGA,governance,role,entitlement,SOD,access,provisioning,audit,compliance

*(97 chars. "SailPoint" is generally acceptable in the hidden keyword field
for legitimate compatibility claims, unlike in the name/subtitle.)*

## Category

- **Primary:** Business
- **Secondary:** Productivity

## Age Rating

4+ (no objectionable content)

## Support & Marketing URLs

- Support URL: https://adminstudio.kccs.net (or a dedicated support page)
- Marketing URL: https://adminstudio.kccs.net

## Privacy Notes (for App Privacy questionnaire)

- Sign-in is OAuth authorization-code against the customer's own SailPoint
  tenant; the app stores an opaque session ID only (sessionStorage), never
  credentials or tokens.
- Identity data (names, emails, titles, entitlements) is displayed from the
  customer's ISC tenant via the app's proxy server; nothing is sold or
  shared with third parties, and no advertising/tracking SDKs are present.
- AI description generation sends role/source facts (names, entitlements,
  membership rules — no personal credentials) to an LLM API configured
  server-side.
- Likely App Privacy classification: "Data Linked to You: Contact Info,
  Identifiers (as displayed enterprise directory data)" — review against
  Apple's current questionnaire before submission.

## What's New (first release)

 Initial release: role mining with peer-group discovery, role evaluation
 with SOD repair and mitigations, full ISC browsing (identities, roles,
 access profiles, sources, approvals), backup/restore with ZIP export,
 PDF reports, and SailPoint-hosted OAuth sign-in with MFA/SSO support.

---

### Screenshot suggestions (6.7" and 6.1" required sets)

1. Dashboard — metric tiles + role statistics (health at a glance)
2. Role mining scan results — discovered peer groups
3. Role Evaluation — SOD violation with repair flow
4. Identity detail — tabs for roles/access/accounts/entitlements
5. Sign-in screen — "You sign in with SailPoint" trust message
6. Reports — generated PDF preview
