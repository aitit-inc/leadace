-- stripe_subscription_id now holds a subscription only until it ends, and free
-- with one held reads as unpaid. Rows from before kept the id after a
-- cancellation; clear them. A live past_due subscription gets its id back from
-- its next event (the mirror writes while the row holds none).
UPDATE tenant_plans SET stripe_subscription_id = NULL WHERE plan = 'free';
