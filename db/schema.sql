-- Minimal schema: users, accounts, transactions, ledger_entries
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE accounts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0, -- cents
  currency TEXT NOT NULL DEFAULT 'PHP',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE ledger_entries (
  id SERIAL PRIMARY KEY,
  transaction_id INT REFERENCES transactions(id) ON DELETE CASCADE,
  account_id INT REFERENCES accounts(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL, -- positive credit, negative debit
  balance_after BIGINT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Trigger: prevent negative balance on insert of ledger_entries
CREATE OR REPLACE FUNCTION prevent_negative_balance() RETURNS trigger AS $$
BEGIN
  IF (NEW.balance_after < 0) THEN
    RAISE EXCEPTION 'negative balance not allowed for account %', NEW.account_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_negative BEFORE INSERT ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_negative_balance();

-- Trigger: audit log example (simple insert into transactions table if missing)
CREATE OR REPLACE FUNCTION ensure_transaction_exists() RETURNS trigger AS $$
BEGIN
  IF NEW.transaction_id IS NULL THEN
    INSERT INTO transactions (reference, description) VALUES (md5(random()::text || clock_timestamp()::text), 'auto') RETURNING id INTO NEW.transaction_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ensure_tx BEFORE INSERT ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION ensure_transaction_exists();

CREATE INDEX idx_ledger_account ON ledger_entries(account_id);
