# Go-live runbook -- October 2026 release

**What goes live:** Leads + the public enquiry page, the new dashboard and
design, and the ledger work (ADR 0008 and its 2026-10-09 amendment: price
corrections, closing the books, the nightly check).

**Who runs it:** the owner, by hand. Every command and every SQL query is
below, in order. Nothing in here deletes or changes your existing orders,
payments or staff: the 8 database changes only **add** tables, columns, checks
and indexes. The only edits to existing rows: a ₹0 order is marked Fully paid,
and the status history gets a new "from stage" column filled in.

**Time needed:** about 45 minutes. The app is unusable for staff for about 20
of them (between step 7 and step 10).

**The rule for the whole day:** if any step doesn't show what this guide says
it should, **stop** and send the screen to your developer. Don't skip ahead.

---

## 0. The day before

- [ ] Test the new features locally (closing a month, price corrections, Fetch
      customer details) and say yes to the release.
- [ ] Your developer has committed the work and you know it's ready to push.
- [ ] Install / open **Docker Desktop** and leave it running (the backup command
      needs it).
- [ ] Have these ready: your **Supabase project ref** (Project Settings →
      General → Reference ID) and the **database password**.
- [ ] Pick a quiet time (e.g. after closing) and tell the staff: "The app is
      off from __:__ to __:__."
- [ ] Make a folder for the backups **outside** the project folder, e.g.
      `D:\NeedleyeBackups\2026-10-go-live\`. The backups hold customer names and
      phone numbers: never put them in the project or in git.

All commands below are run in **PowerShell**, in the API folder:

```powershell
cd "D:\Code Space\WorkSpace\needleye-pilot\needleye-api"
```

## 1. Connect to the live project and see what will change

```powershell
npx --yes supabase@2.117.0 login
npx --yes supabase@2.117.0 link --project-ref <YOUR-PROJECT-REF>
npx --yes supabase@2.117.0 migration list
```

`migration list` shows two columns, **Local** and **Remote**.

**Expected:** Remote ends at `20260925000003`, and these 8 are on Local only:

```
20261005000001  zero_total_orders_fully_paid
20261006000001  leads
20261008000001  order_stages_marking_ready
20261009000001  order_pricing_and_payment_rules
20261010000001  split_audit_logs
20261011000001  ledger_daily
20261012000001  close_books_and_reconciliation
20261013000001  price_corrections_and_books
```

**If it's different** (more or fewer missing, or Remote has something Local
doesn't): stop and send the screen.

## 2. Backup 1 -- a full copy on your computer

```powershell
$B = "D:\NeedleyeBackups\2026-10-go-live"
npx --yes supabase@2.117.0 db dump --linked -f "$B\schema.sql"
npx --yes supabase@2.117.0 db dump --linked --data-only -f "$B\data.sql"
npx --yes supabase@2.117.0 db dump --linked --role-only -f "$B\roles.sql"
```

**Check:** the three files exist in the folder and none is 0 KB. `data.sql`
should mention your orders (open it in Notepad and search for an order number).

## 3. Backup 2 -- a copy inside the database

Open the Supabase dashboard → **SQL Editor** → New query. Paste and **Run**:

```sql
-- A copy of every table, structure and data, in its own schema. The app never
-- uses it; it's only there to restore from if something goes wrong.
create schema if not exists backup_20261009;
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('create table backup_20261009.%I as table public.%I', t.tablename, t.tablename);
  end loop;
end $$;
revoke all on schema backup_20261009 from anon, authenticated;
```

Then save today's counts (keep this result -- screenshot it):

```sql
select 'orders' as what, count(*) from public.orders
union all select 'payments', count(*) from public.payments
union all select 'payments total ₹', coalesce(sum(amount), 0) from public.payments
union all select 'staff (profiles)', count(*) from public.profiles
union all select 'stage history', count(*) from public.order_status_history
union all select 'order images', count(*) from public.order_images
union all select 'audit log', count(*) from public.audit_log;
```

**Expected:** about 99 orders, and the same numbers you'd expect from the app.

## 4. One check before the change: ₹0 orders

```sql
select order_number, customer_name, booking_date, production_status
from public.orders where total_amount = 0 order by booking_date;
```

After the release, a ₹0 order counts as **free work, Fully paid**. If any order
in this list is NOT free work (the price was just never entered), write its
number down: after go-live, the Owner corrects its price on the order page
(allowed, as long as its month isn't closed).

## 5. Dry run -- see exactly what will be applied

```powershell
npx --yes supabase@2.117.0 db push --dry-run
```

**Expected:** it lists the same 8 files as step 1, and nothing else. It changes
nothing.

## 6. Staff off

Tell the staff to stop now and close the app. (From the next step until the new
app is live, marking an order Delivered won't work.)

## 7. Apply the database changes

```powershell
npx --yes supabase@2.117.0 db push
```

It lists the 8 files and asks to confirm: type **y**, Enter.

**Expected:** each file shows "Applying migration …" and it ends with
**Finished supabase db push.** (about a minute).

**If it stops with an error:** don't continue and don't deploy. Nothing is
lost: the file that failed was undone automatically, and the ones before it
only added things. Copy the whole error and send it to your developer.

> If the error mentions **pg_cron**: in the dashboard → Database → Extensions,
> turn on **pg_cron**, then run `db push` again (it continues from where it
> stopped).

## 8. Check the database

In the SQL Editor:

```sql
-- 1) Nothing was lost: the same numbers as in step 3.
select 'orders' as what, count(*) from public.orders
union all select 'payments', count(*) from public.payments
union all select 'payments total ₹', coalesce(sum(amount), 0) from public.payments
union all select 'staff (profiles)', count(*) from public.profiles
union all select 'stage history', count(*) from public.order_status_history
union all select 'order images', count(*) from public.order_images
union all select 'audit log', count(*) from public.audit_log;
```

**Expected:** exactly the same numbers as step 3.

```sql
-- 2) The books check: recounts every order and payment.
select public.ledger_reconcile('manual');
select status, days_checked, mismatched_days, overpaid_orders, status_mismatches, closed_month_drift
from public.ledger_reconciliations order by started_at desc limit 1;
```

**Expected:** `status` = **verified**, and every other number after
`days_checked` is **0**.

```sql
-- 3) The nightly check is scheduled (02:00 India time).
select jobname, schedule from cron.job;
```

**Expected:** `needleye-ledger-reconcile` with `30 20 * * *`.

If any of these isn't as expected: stop, don't deploy, send the result.

## 9. Deploy the new app

Pushing to `main` deploys automatically (API → Railway, website → Vercel).
**API first.** No new settings are needed on Railway or Vercel (every new API
setting has a safe default; `ACCOUNTING_CYCLE_START_DAY` is no longer used and
can be deleted from Railway any time).

```powershell
cd "D:\Code Space\WorkSpace\needleye-pilot\needleye-api"
git checkout main
git merge --ff-only feature/ledger-integrity
git push origin main
```

Wait for Railway to show the new deployment as **Active** (3-5 minutes), then
open `https://<your-api-domain>/health` -- it must say `"status":"ok"`.

```powershell
cd "D:\Code Space\WorkSpace\needleye-pilot\needleye-web"
git checkout main
git merge --ff-only feature/ledger-integrity
git push origin main
```

Wait for Vercel to show the new deployment as **Ready** (2-4 minutes).

> If `git merge --ff-only` refuses ("Not possible to fast-forward"): stop and
> ask your developer -- don't force it.

## 10. Try it -- 10 minutes

Sign in on the live site and check:

- [ ] **Owner:** the orders dashboard loads (the board, pipeline, deliveries,
      payments). Open one order: its price, payments and history look right.
- [ ] **Revenue & Ledger:** the month cards and the month table load; the books
      bar says **Books verified**.
- [ ] **Create a test order** (any customer), set a price, record a payment,
      then **correct the price** once -- then delete that test order's payment
      and leave it, or keep it as a real one.
- [ ] **Designer** (or use QR login on a phone): sees only their orders; can
      record a payment on their own order.
- [ ] **Leads:** the Leads page opens; the public page `/enquiry` opens and the
      form appears.
- [ ] On a **phone**: the dashboard and an order page look right.

Then tell the staff the app is back.

## 11. If something goes wrong

| What you see | What to do |
|---|---|
| `db push` failed (step 7) | Stop. Nothing is lost. Send the error. Don't deploy. |
| Counts or the books check differ (step 8) | Stop. Don't deploy. Send the results. The backup copy (step 3) and the files (step 2) are untouched. |
| The new API doesn't start on Railway | Railway → Deployments → the previous one → **Redeploy**. The old app works with the new database for a short while (except marking Delivered). Send the deploy logs. |
| The website shows errors | Vercel → Deployments → the previous one → **Promote to Production** (instant). Send a screenshot. |
| Data looks wrong after go-live | Don't change anything by hand. Send what you see; your developer restores from the backup copy with you. |

## 12. Afterwards

- Keep `D:\NeedleyeBackups\2026-10-go-live\` and the `backup_20261009` schema
  until Supabase Pro is on and its first daily backup exists.
- Then, in the SQL Editor: `drop schema backup_20261009 cascade;`
- The first nightly books check runs at 2:00 AM; next morning the Revenue page's
  books bar should say **Books verified** with "nightly".
- The ₹0 placeholder orders you noted in step 4: correct their prices.
