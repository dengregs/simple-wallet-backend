-- ============================
-- TRIGGERS AND CONSTRAINTS
-- ============================

-- 1) Automatically create an account for each new user
CREATE OR REPLACE FUNCTION fn_create_account_after_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO accounts (user_id, balance)
        VALUES (NEW.id, 0)
        ON CONFLICT DO NOTHING;
    INSERT INTO account_versions (account_id) VALUES (currval('accounts_id_seq'))
        ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_create_account_after_user ON users;
CREATE TRIGGER trg_create_account_after_user
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION fn_create_account_after_user();

-- 2) Prevent negative balance at ledger-entry level
CREATE OR REPLACE FUNCTION fn_prevent_negative_balance()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.balance_after < 0 THEN
        RAISE EXCEPTION 'Negative balance not allowed on account %', NEW.account_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_negative ON ledger_entries;
CREATE TRIGGER trg_prevent_negative
BEFORE INSERT ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION fn_prevent_negative_balance();

-- 3) Audit ledger entry inserts
CREATE OR REPLACE FUNCTION fn_audit_ledger_insert()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_log (event_type, details)
    VALUES (
        'ledger_insert',
        jsonb_build_object(
            'ledger_entry_id', NEW.id,
            'transaction_id', NEW.transaction_id,
            'account_id', NEW.account_id,
            'amount', NEW.amount,
            'balance_after', NEW.balance_after,
            'metadata', NEW.metadata
        )
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_ledger_insert ON ledger_entries;
CREATE TRIGGER trg_audit_ledger_insert
AFTER INSERT ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION fn_audit_ledger_insert();

-- 4) Prevent deletion of ledger entries (ledger is immutable)
CREATE OR REPLACE FUNCTION fn_prevent_ledger_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Ledger entries cannot be deleted. Use reversal instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_no_ledger_delete ON ledger_entries;
CREATE TRIGGER trg_no_ledger_delete
BEFORE DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION fn_prevent_ledger_delete();

-- 5) Ensure accounts.balance >= 0 (redundant safety)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_balance_nonnegative'
    ) THEN
        ALTER TABLE accounts
        ADD CONSTRAINT chk_balance_nonnegative CHECK (balance >= 0);
    END IF;
END$$;
