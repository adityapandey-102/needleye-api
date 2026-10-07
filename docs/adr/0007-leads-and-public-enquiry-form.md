# 0007: Leads, the public enquiry form, and the Ledger Activity export

## Status

Accepted (2026-10-06), built on branch `feature/leads-and-ledger-export` in both
repos; merged to `main` only after the owner approves. Every decision below was
made with the owner (shop owner) in conversation -- this file is the record.

## Context

Two additions to the live app:

1. **Ledger Activity export.** The accountant tracks payments month by month and
   week by week, and needs the Ledger Activity table (who recorded, edited or
   removed which payment, when) as a file -- CSV and PDF -- like the Revenue
   statement already offers.
2. **Leads.** Customers enquire before they order. The owner wants every
   enquiry captured, handed to a designer, worked to an order (or closed), and
   tracked -- with enquiries arriving from a **public form anyone can open**,
   which must not become a way into the system.

## Decisions -- Ledger Activity export

1. **Same rows as the table, week or month only.** The export is exactly what
   Ledger Activity shows for the chosen Month (e.g. June) or Week -- every row,
   not just the visible page -- plus a totals block (recorded, removed, net of
   edits, net change). **No yearly export**: the buttons hide in Year view, and
   `GET /orders/ledger-events/export` refuses any window over 31 days
   (`LEDGER_EXPORT_RANGE_INVALID`) and any window over 5,000 rows
   (`LEDGER_EXPORT_TOO_LARGE`) instead of returning a partial file.
2. **No migration, no new storage.** It reads the existing `audit_log`.
3. **CSV built in the browser** (like the revenue CSV); **PDF is a print page**
   (`/revenue/ledger-print`) saved with the browser's "Save as PDF" -- no PDF
   library in the bundle.
4. **Shop-day boundaries.** Both the table and the export now cut days at
   midnight in `BUSINESS_TIMEZONE` (a payment at 00:30 IST on 1 July is July's),
   not UTC -- previously the table filed it under June. The export response
   carries the timezone, so the server-rendered PDF prints IST times.
5. **CSV injection defused.** Text cells beginning with `= + - @` (or tab/CR)
   get a leading apostrophe so a name typed as a formula can't run in Excel.

## Decisions -- Leads

### Who sees and does what

| | Owner/Manager | Designer | Everyone else |
|---|---|---|---|
| See leads | all | **only their own** (others' answer 404 -- existence never leaks) | no access (403) |
| Add a lead by hand | yes | no | no |
| Assign / reassign to a designer | yes | no | no |
| Change stage | any open stage, discard, reopen | forward on their own leads | no |
| Comment | yes | on their own leads | no |

Capabilities: `leads:read` (owner `true`, designer `"assigned"`) and
`leads:manage` (owner only). Everything else in the app is unchanged, and
**nothing about leads appears on the orders dashboard** -- Leads is its own
sidebar section (Customers -> Leads) with its own dashboard.

### Stages

`New` (unassigned) -> `Assigned` (given to a designer) -> `Unattended` (the
designer tapped **Received**) -> `Attended` (spoke to the customer) <->
`Follow-up` (optional next date, never in the past) -> `Converted` | `Lost`
(reason required) ; `Discarded` (owner, unassigned leads only -- spam, fake,
duplicate). Rules live in `modules/leads/domain/lead-status.rules.ts`:

- A designer must tap Received before working a lead; they can't skip it.
- `Assigned` is reached only through Assign; `Converted` only by **saving an
  order for the lead** -- never by a plain stage change.
- The owner can set any working stage, reopen a Lost lead (back to its
  designer as Unattended) and restore a Discarded one (back to New).
- Reassigning puts the lead back to `Assigned` for the new designer.

### Converting

Choosing **Converted** opens "Create an order for this lead?". *Create order*
opens the order form pre-filled with the customer's name, phone and requirement;
**the lead becomes Converted only when that order is saved**: `POST /orders`
with `leadId` converts the lead **inside the order's insert transaction**
(`leads/infrastructure/lead-conversion.ts`, an Infra->Infra write per ADR 0003).
If the lead can't be converted (not the caller's, not yet received, already
closed) the whole create is refused (`409 LEAD_NOT_CONVERTIBLE`) and no order
exists. *Cancel* changes nothing.

### The badge

A red count on the sidebar's Leads item; on a phone with the menu closed it sits
on the **logo** in the top bar, and on the Leads item when the menu is open. It
also prefixes the browser tab title ("(3) Needleye") and sets the installed
app's icon badge where the device supports it (Badging API).

- Owner: unassigned `New` leads. Designer: their `Assigned` leads (cleared by
  Received) plus their open urgent ones.
- **Refreshed on open / reopen / reload and every 10 minutes** (owner's choice:
  not every minute), and immediately after an action that changes it. One
  indexed count per refresh (~0.1 ms at 20k leads).
- Real push notifications to a closed phone are out of scope for now.

### Repeat enquiries from the same phone

Counted per phone over **24 hours from that phone's first enquiry**:

- 1st: a New lead.
- 2nd within the window: **merged into the first lead** -- the new requirement
  (and a differing name) is added to its history, `enquiry_count` becomes 2,
  and it is marked **Urgent**. A closed lead reopens: Discarded -> New (owner),
  Lost -> Unattended (its designer); Converted stays converted but is flagged.
- 3rd and later within the window: **no lead**; the customer sees: "Thank you
  for reaching out again. We've already received your enquiries today, and our
  team will contact you shortly. Please share all your requirements on that
  call. We appreciate your patience."
- After 24 hours a new window starts (a new lead).
- Urgent shows to the owner while unassigned and to the designer once assigned;
  it clears when the customer is contacted (Attended / Follow-up / Lost /
  Converted). Urgent leads sort first.

Serialised per phone with a transaction-scoped advisory lock, so two quick
submits can't both be "the first".

### Designers at scale (no whole-team lists)

- The owner's **Designers** table (how each designer is doing) is its own
  endpoint, `GET /leads/designers`: designers with leads, busiest first, **name
  search (debounced) and pages of 10**. `/leads/summary` no longer carries a
  per-designer list.
- Choosing a designer -- the All leads filter, Assign, and the manual form's
  "Assign to" -- is a **type-ahead** (`DesignerPicker`) over
  `GET /team-members?role=designer&q=&limit=8`, never a dropdown of everyone.
- Every lead search box is debounced (300 ms); the E2E suite checks that four
  quick keystrokes send one request.

### Manual leads

Owner only: name, mobile, requirement, **where it came from** (walk-in, phone
call, Instagram, WhatsApp, referral, other) and optionally a designer to assign
at once. Manual leads are not de-duplicated (the owner decides).

## Decisions -- the public enquiry form (`/enquiry`)

Open to anyone; fields: name, mobile number, requirement; on success: "Thank
you! We've received your enquiry. Our team will contact you shortly."

**Security -- defence in depth, outermost first:**

1. **Its own entry point** `/api/v1/public/*`, mounted before the global JSON
   parser with an **8 kB body limit** (413 above it); malformed JSON is a 400
   (this also fixed a pre-existing bug where any malformed JSON body answered
   500 "A database error occurred").
2. **Rate limits:** 5 enquiries per IP per hour and 200 per hour for everyone
   (`PUBLIC_ENQUIRY_*` env), keyed on the real client IP (`TRUST_PROXY`).
3. **Strict schema:** unknown fields rejected; name = letters (any script),
   spaces and `. ' -`, 2-80 chars; phone = a real Indian mobile, normalised to
   10 digits; requirement = plain text <= 1,000 chars with control and
   text-direction characters stripped.
4. **Bot checks:** a hidden honeypot field, and a signed open-time token
   (HMAC; `PUBLIC_FORM_SECRET`, default derived from the service-role key) --
   a submission faster than 3 s, or a forged / expired (2 h) token, is not
   stored. Bots get the same "received" reply, so they learn nothing.
5. **Cloudflare Turnstile -- built in, switched OFF.** `TURNSTILE_ENABLED=false`
   until the owner turns it on (planned ~1 month after launch); then two keys +
   one switch, no code change. Guide: `docs/guides/turn-on-turnstile.md`.
   The check fails closed (Cloudflare unreachable = not verified).
6. **2 per phone per 24 h** (above).
7. **SQL injection:** every query is parameterised (Drizzle `sql` template);
   SQL in a text field is stored as inert text. **XSS:** text is only ever
   rendered as text by React; never as HTML.
8. **No data comes back:** the response is a fixed message -- no ids, no echo.
9. **Database:** the leads tables have RLS on and no policies, so the anon key
   and signed-in browsers can't read them directly; only the API (service role /
   `needleye_app`) can.

Checked by `tests/integration/leads.integration.test.ts` and
`npm run test:public-form -- --base=<api>/api/v1` (credential-free; sends only
bodies that must be refused, so it stores nothing -- safe against production).

### The page

A brand page, not a bare form: large logo, who Needleye is and what it makes,
the four steps from enquiry to fitting, Instagram link, and a moving "garment
rail" of design photos. Photos come from `needleye-web/public/brand/` (any
JPG/PNG/WebP/AVIF, in file-name order; see the README there) -- Instagram can't
be fetched without a login and its image links expire, so photos are copied in.
With no photos the rail shows woven fabric swatches.

The first set of 14 photos comes from Needleye's previous WordPress site
(`wp-content/uploads`): **only the boutique's own pieces photographed on its
studio mannequins** and its blouse close-ups, plus one photo of the real fabric
showroom for the "Our studio" section. Model/bride shots on that site look
like licensed stock or blog illustrations (stock-library file names), so they
are deliberately **not** used: they would present someone else's photos as
Needleye's work. Resized to at most 900 px tall, WebP (~640 KB total).

The site icon (browser tab, home-screen) is the logo's own "N" emblem on the
logo's sand colour (`app/icon.png`, `apple-icon.png`, `favicon.ico`): the full
logo's wordmark is unreadable at 16-32 px. The pages still show the full logo. Motion is pure CSS
transforms (no JS), slower and smaller on phones, paused on touch/hover, and
stopped for "reduce motion".

## Data model

Migration `20261006000001_leads.sql`: `leads` (lead number `LEAD-{year}-{seq}`
by trigger), `lead_comments` (append-only), `lead_events` (history:
created / enquiry_merged / assigned / status_changed / converted),
`lead_counters`. Indexes for the owner's stage lists, a designer's leads and
badge, the per-phone check, and trigram search. Grants to `service_role` only;
the least-privilege role script grants `needleye_app` the same.

## Consequences

- Two migrations to apply in production before deploying this branch:
  `20261005000001` (zero-total orders, already on `main`) and
  `20261006000001` (leads).
- New optional env vars (all safe by default): `PUBLIC_FORM_SECRET`,
  `PUBLIC_ENQUIRY_RATE_LIMIT_MAX`, `PUBLIC_ENQUIRY_RATE_LIMIT_WINDOW_MS`,
  `PUBLIC_ENQUIRY_GLOBAL_MAX_PER_HOUR`, `TURNSTILE_ENABLED`,
  `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`.
- The rate limiters are in-memory (per instance), like the login limiter.
