-- A zero-total order is now "fully_paid", not "unpaid".
--
-- The shop takes free work (promotions, friends, design contests) and books it
-- with a total of 0. derivePaymentStatus used to call that "unpaid", so those
-- orders sat in Pending Payments / Overdue and the dashboard's pending count,
-- while the web (which reads the 0 balance) labelled the same rows "Fully Paid".
-- The rule now says: nothing to collect = fully_paid (API + web). This brings
-- existing rows in line. Payments can never exceed the total, so a 0-total
-- order has no ledger entries -- nothing else to reconcile. Editing the total
-- up later re-derives the status (unpaid / advance_paid) as before.
update public.orders
set payment_status = 'fully_paid'
where total_amount = 0
  and payment_status <> 'fully_paid';
