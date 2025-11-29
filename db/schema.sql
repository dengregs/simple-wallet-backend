-- ============================
-- DATABASE SCHEMA (STRUCTURE)
-- High-Concurrency Wallet/Ledger
-- ============================

-- 1) USERS
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2) ACCOUNTS
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    currency TEXT NOT NULL DEFAULT 'PHP',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_accounts_user ON accounts(user_id);

-- OPTIONAL: versioning for optimistic concurrency
CREATE TABLE IF NOT EXISTS account_versions (
    account_id INT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    version BIGINT NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ DEFAULT now()
);

-- 3) TRANSACTIONS (transaction header)
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    tx_type TEXT NOT NULL,
    reference TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4) LEDGER ENTRIES (double-entry bookkeeping)
CREATE TABLE IF NOT EXISTS ledger_entries (
    id SERIAL PRIMARY KEY,
    transaction_id INT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL,                -- +credit / -debit
    balance_after BIGINT NOT NULL,         -- after applying amount
    reversed BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ledger_account ON ledger_entries(account_id);
CREATE INDEX idx_ledger_tx ON ledger_entries(transaction_id);

-- 5) AUDIT LOG
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);
