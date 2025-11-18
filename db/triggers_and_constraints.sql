-- 1) Audit table for important events
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2) Auto-create account after a user is inserted (if not exists)
CREATE OR REPLACE FUNCTION fn_create_account_after_user()
RETURNS TRIGGER AS $$
BEGIN
  -- create an account for the new user if none exists
  INSERT INTO accounts (user_id, balance)
    VALUES (NEW.id, 0)
    ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_create_account_after_user ON users;
CREATE TRIGGER trg_create_account_after_user
AFTER INSERT ON users
FOR EACH ROW
EXECUTE PROCEDURE fn_create_account_after_user();

-- 3) Audit trigger for ledger entries (double-entry, log each insert)
CREATE OR REPLACE FUNCTION fn_audit_ledger_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (event_type, details)
    VALUES ('ledger_entry_insert', jsonb_build_object(
      'ledger_entry_id', NEW.id,
      'transaction_id', NEW.transaction_id,
      'account_id', NEW.account_id,
      'amount', NEW.amount,
      'balance_after', NEW.balance_after,
      'metadata', NEW.metadata
    ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_ledger_insert ON ledger_entries;
CREATE TRIGGER trg_audit_ledger_insert
AFTER INSERT ON ledger_entries
FOR EACH ROW
EXECUTE PROCEDURE fn_audit_ledger_insert();

-- 4) Ensure accounts.balance cannot go negative at DB level
ALTER TABLE accounts
  ADD CONSTRAINT IF NOT EXISTS accounts_balance_nonnegative CHECK (balance >= 0);
