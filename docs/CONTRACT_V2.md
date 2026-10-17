# RevenueGuard UX v2 — API contract (business layer)

Additive to docs/CONTRACT.md. All endpoints need the Bearer JWT and are tenant-scoped. Money values are
**integers in rupees** (no paise) unless named `_paise`. Dates are ISO strings; the UI formats them in IST.
Every list response is `{ "items": [...] }` (plus extra keys where shown). Errors: `{ "detail": "plain English" }`.

Roles: `admin` (owner), `operator` (accounts), `finance_approver`, `viewer`. Writes noted with the role that may call them.

## Dashboard
GET /dashboard/summary?period=month|30d|quarter
```
{ "not_billed": {"amount":412000,"count":6,"oldest_days":11},
  "overdue":    {"amount":215500,"count":4,"reminders_sent":3},
  "recovered":  {"amount":340000,"invoices":5,"last_month":185000},
  "waiting":    {"amount":82600,"count":1},
  "flow": {"ordered":1240000,"delivered":1035000,"billed":623000,"paid":407500},
  "to_bill":  [ToBillRow...top 5], "to_chase": [ChaseRow...top 5], "approvals": [ApprovalCard...top 5] }
```
ToBillRow: `{case_ref, customer_id, customer, po_ref, headline, status:"not_billed"|"partial"|"needs_check", waiting_days, amount, proofs:[Proof]}`
Proof: `{kind:"email"|"whatsapp"|"photo"|"voice"|"sheet"|"zoho"|"pdf"|"bank", label, node_id}`
ChaseRow: `{invoice_number, customer_id, customer, amount, due_date, days_late, reminder:{stage:0|7|15|30, status:"none"|"draft"|"sent"|"read"|"replied"}, snoozed_until}`

## Lists
GET /bill?status=&customer=&q=          -> {items:[ToBillRow], total_amount}
GET /collect?bucket=all|0-7|8-30|31-60|60+ -> {items:[ChaseRow], total_amount}
POST /bill/{case_ref}/not-billable  {reason:"sample"|"replacement"|"returned"|"billed_elsewhere"|"other", note}  (operator+) -> {ok}
POST /collect/{invoice_number}/snooze {days, reason} (operator+) -> {ok, snoozed_until}

## Case (business view)
GET /cases/{ref}/summary
```
{ case_ref, po_ref, customer, customer_id, headline, recommendation, confidence:"high"|"needs_check", confidence_reason,
  journey: {current:"received"|"read"|"matched"|"checked"|"waiting"|"invoiced"|"verified"|"paid", problem:null|{reason,next}, steps:[{key,status:"done"|"current"|"waiting"|"problem"|"todo", at, caption}]},
  documents: [{stage:"order"|"delivery"|"invoice"|"payment", status:"found"|"partial"|"conflict"|"missing", date, source, key_number}],
  facts: [{id, label, value, source:Proof, changed_from:null|string, at}],
  callouts: [{kind:"approval_expired"|"quarantined"|"corrected", text}],
  invoice_preview: GstPreview|null, approval: ApprovalCard|null, how_found:{agents, checks, seconds, extra_searches:[string]} }
```
Headline/recommendation are built from validator facts by templates (`services/api/app/plain_language.py`), never free LLM text. `?lang=hi|te` returns Hindi/Telugu.

POST /cases/{ref}/facts/{fact_id}/correct {value, note} (operator+) -> new evidence version, expires open approvals, re-runs validator -> {ok, evidence_version}

GstPreview: `{seller_gstin, buyer_gstin, place_of_supply, lines:[{item, hsn, qty, rate, taxable}], cgst, sgst, igst, round_off, total, total_words, irn_note:null|string}`
The approval payload hash includes the GST lines.

## Approvals
GET /approvals (existing) — each item also has `card: ApprovalCard`
ApprovalCard: `{id, case_ref, customer, po_ref, what, amount, gst, total, approvers_needed, approvals:[{user, at}], proofs:[Proof], expires_reason:null|string, kind:"invoice"|"reminder"}`
POST /approvals/bulk-approve {ids:[...]} (finance_approver) -> {results:[{id, ok, detail}]}  — calls the same single-approve logic per id.

## Customers
GET /customers -> {items:[{id, name, gstin, city, outstanding, overdue, avg_days_to_pay, terms_days, risk:"good"|"watch"|"high", risk_reason}]}
GET /customers/{id} -> {customer:{...+contact_masked}, stats:{not_billed, overdue, avg_days_to_pay, terms_days, risk, risk_reason}, orders:[{po_ref, case_ref, ordered, delivered, billed, paid, amount}], followups:[{at, kind, text, status}]}

## Unlinked inbox
GET /unlinked -> {items:[{id, source:Proof, received_at, from, preview, extracted:{po_ref?, customer?, qty?}, suggestions:[{case_ref, po_ref, customer, confidence}]}]}
POST /unlinked/{id}/link {case_ref} (operator+) -> {ok}  — also saves aliases learned (customer spelling, PO variant)
POST /unlinked/{id}/ignore -> {ok}
GET /aliases -> {items:[{kind:"customer"|"po", alias, canonical}]}

## Reminders / collections
POST /collect/{invoice_number}/draft-reminder {stage} -> ApprovalCard (kind "reminder"); body contains `upi://pay?pa=<vpa>&pn=<name>&am=<amount>&tn=<invoice>`; sending still goes through approval + gateway.

## Reports
GET /reports/summary?from=&to= -> {recovered_by_month:[{month, amount}], unbilled_ageing:{"0-7":n,"8-30":n,"31-60":n,"60+":n}, collections:{billed, collected, rate}}
GET /reports/export?from=&to=&format=csv -> text/csv (GST columns). (xlsx optional)

## Settings
GET /settings -> {company:{name, gstin, state_code, upi_vpa}, digest:{enabled, time:"09:00", channels:["whatsapp","email"]}, receipts_enabled, reminder_ladder:[7,15,30], gst_default_rate:18, einvoice_turnover_threshold, language:"en"|"hi"|"te"}
PUT /settings {partial} (admin)
GET /settings/team -> {items:[{id, name, email, role, phone_masked}]}
PUT /settings/notifications {approvals, digest, receipts, problems, quiet_hours:{from,to}} (self)
PUT /me/phone {phone} (self) — links an approver phone for WhatsApp approvals.

## Connections / setup
GET /connectors (existing) — each item adds `health:"ok"|"slow"|"down"|"relogin"`, `last_sync`, `error_plain`.
GET /connectors/whatsapp/chats -> {items:[{jid, name, is_group, last_message_at, watched}]}
PUT /connectors/whatsapp/chats {watched:[jid]} (admin) — forwarded to wa-bridge allowlist.
POST /connectors/sheets/propose-mapping {sheet_id, tab} -> {columns:[{header, meaning, confidence:"sure"|"check", sample}]}
POST /connectors/sheets/config (existing) accepts `mapping`.
POST /setup/backfill {days:90} -> {job_id}; GET /setup/backfill -> {sources:[{name, done, total, status}], first_case_ref}

## Ask
POST /ask {question, lang?} -> {answer, table:{columns,rows}|null, proofs:[Proof], actions:[{label, href}]}
Read-only: deterministic intent router over the same queries (receivables, unbilled, case lookup) first; the harness "analyst" agent (read tools only) when available. Refuses writes.

## Events (WebSocket /ws, existing) — UI live feed
Feed lines are built client-side from `case.updated | checkpoint | agent.event | approval.updated | guardrail` with a deterministic caption map. `GET /events/recent` for catch-up.

## wa-bridge (internal)
GET  /chats -> [{jid,name,is_group,last_message_at}]
PUT  /allowlist {jids:[...]} ; GET /allowlist
Messages from non-allowlisted chats are dropped before storage/forwarding (default: empty list = drop everything, except DEMO/WA_MOCK).
POST /send-internal {to, text} — team-only messages (receipts "Got it ✓", "Which PO?", approval prompts, digest). Customer messages still only via gateway.
Approval replies "1"/"2"/"3" from linked approver phones -> POST api /internal/wa-approval-reply {phone, approval_id, choice, token}.

## Demo toggle
The web app has a runtime **Demo switch** (top bar + login page), stored in localStorage `rg.demo`. On = in-browser mock backend (no server needed); Off = real API at NEXT_PUBLIC_API_URL. Default = NEXT_PUBLIC_MOCK. Switching signs the user out and reloads.

## API implementation notes and deviations (services/api, 15 Oct 2026)
Implemented in `services/api/app/{business,plain_language,gst,invoicing,reminders,unlinked,sheet_mapping,notify,backfill,ask}.py`,
`app/routers/business.py` (+ additions in `routers/connectors.py`, `routers/internal.py`, `routers/core.py`). All shapes above
are returned as written; the items below are **additions or deliberate deviations** the web mock should mirror.

- **ToBillRow.status** also returns `"scheduled"` (delivered, but the customer's billing rule says bill after a date; row
  carries `due_at`) and, only for `GET /bill?status=not_billable`, `"not_billable"` (marked rows otherwise leave the list).
  The UI's "Under-billed" tag = `partial` (some units already invoiced). `not_billed.amount/count` on the dashboard exclude `scheduled`.
- **Proof.kind** may also be `"manual"` (a user's "This is wrong" correction, or `{label:"Calculated", node_id:null}` for the
  validator's billable amount in case facts).
- **GstPreview** adds `taxable`, `tax_total`, `rate` and per-line `gst_rate`. `cgst/sgst/igst/round_off` may carry paise
  (2-dp numbers); `total` is whole rupees. The approval payload carries the same block as `action.gst` (hash-bound).
- **Invoices include GST.** The mock Zoho invoice for PO-184 is ₹82,600 (₹70,000 + ₹12,600). Live Zoho needs
  `connectors.zoho.config.tax_ids` (`{"18": "<tax_id>"}`); without it the invoice is written untaxed and the verifier checks
  the taxable amount. The 2-approver threshold still uses the taxable amount (> ₹1,00,000), as before.
- **ApprovalCard** adds `status`. `POST /collect/{invoice}/draft-reminder` returns the card plus `message` and `upi_link`.
  Reminder cards: `amount = total = unpaid balance`, `gst = 0`, `po_ref` = the invoice number.
- `GET /approvals` returns the legacy `approvals` list **and** `items` (same objects, each with `card`). `GET /connectors`
  returns `connectors` and `items`.
- `dashboard.waiting` counts **invoice** approvals only (`amount` = their GST totals); reminder approvals appear in `approvals`.
  Dashboard also returns `period` and `as_of`.
- **Customers**: `id` is the Zoho contact id (`name:<slug>` for a customer only seen on a case). Detail adds
  `customer.state_code`, `customer.email_masked`, `stats.outstanding`, `orders[].date`; order values are rupees
  (`billed` = taxable value of invoices with that PO reference). Risk rule: high = any invoice > 60 days late or average
  payment > terms + 30 days; watch = anything overdue or average > terms; else good (`risk_reason` states the rule).
- **Case summary** adds `state` and `lang`. Correctable `fact_id`s: `delivered_qty`, `order_qty`, `rate`, `customer`
  (customer corrections also save a customer alias). Correcting a CLOSED case returns 409.
- `GET /collect?bucket=60+` means 61 days or more. Snoozed invoices stay in the list with `snoozed_until`.
- `GET /reports/summary` defaults to the last 6 months and echoes `from`/`to`.
- `POST /ask` adds `intent` (`receivables|unbilled|case_lookup|invoice_lookup|customer|refused_write|help`); rate-limited to
  30 questions/minute/user. **The harness "analyst" agent is not implemented**: Ask is the deterministic router only.
- Extra endpoints: `GET /settings/notifications` (own prefs), `POST /demo/showcase` (reset + business seed + PO-184 to the
  ₹70,000 approval + PO-185 to its 2-approver approval), `POST /demo/seed-business`. Env `DEMO_BUSINESS_SEED` (default
  true) seeds the business data on an empty tenant at startup; `DEMO_SHOWCASE_ON_START=true` plays the showcase instead.
  Seeded cases use RG-1031..RG-1037 so the live story still opens RG-1042.
- `GET /setup/backfill` adds `job_id`, `status` (`none|queued|running|done|failed`), `days`; each source may carry `error_plain`.
  Source `status`: `queued|running|done|skipped|failed`.
- **WhatsApp approvals**: the API calls wa-bridge `POST /send-internal {to, text, approval:{id, token, expires_at}}` (as
  implemented by wa-bridge). The token is `"<exp>.<hmac>"` over approval id + payload hash + phone, valid 6 h.
  `POST /internal/wa-approval-reply` accepts `choice` `"1"|"2"|"3"` or `"approve"|"reject"|"proof"`, replies
  `{ok, status, reply}`; 401 bad/expired token, 403 phone not linked to a finance approver, 409 approval expired
  (`reply` = "This approval expired because the evidence changed. Here is the new one.", `new_approval_id`, and the new
  prompt is sent). Team receipts / "Which PO?" / digest also go through `/send-internal`; in mock WhatsApp mode they are
  recorded in the connector's `mock.internal_sent` instead.
- Mock WhatsApp chat picker returns six demo chats; the allowlist is stored per tenant (`wa_allowlist` flag) and, in live
  mode, forwarded to wa-bridge `PUT /allowlist` (GET `/chats` and `/allowlist` are HMAC-signed over an empty body).
