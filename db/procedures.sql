-- ============================
-- STORED PROCEDURES
-- ============================

-- Utility: generate unique reference
CREATE OR REPLACE FUNCTION fn_generate_reference()
RETURNS TEXT AS $$
BEGIN
    RETURN md5(random()::text || clock_timestamp()::text);
END
$$ LANGUAGE plpgsql;

-- ==========================================
-- 1) TRANSFER: account → account
-- Uses pessimistic row-level locking
-- ==========================================
CREATE OR REPLACE FUNCTION sp_transfer(
    p_from_account INT,
    p_to_account INT,
    p_amount BIGINT,
    p_note TEXT DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    v_from_balance BIGINT;
    v_to_balance BIGINT;
    v_tx_id INT;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    -- Lock accounts to prevent lost updates
    SELECT balance INTO v_from_balance
      FROM accounts
      WHERE id = p_from_account
      FOR UPDATE;

    SELECT balance INTO v_to_balance
      FROM accounts
      WHERE id = p_to_account
      FOR UPDATE;

    IF v_from_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds for account %', p_from_account;
    END IF;

    -- Create transaction header
    INSERT INTO transactions (tx_type, reference, description)
    VALUES ('TRANSFER', fn_generate_reference(), p_note)
    RETURNING id INTO v_tx_id;

    -- Ledger entries (double-entry)
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (
        v_tx_id, p_from_account, -p_amount, v_from_balance - p_amount
    ), (
        v_tx_id, p_to_account,   p_amount,  v_to_balance + p_amount
    );

    -- Update balances
    UPDATE accounts SET balance = balance - p_amount WHERE id = p_from_account;
    UPDATE accounts SET balance = balance + p_amount WHERE id = p_to_account;

    -- Update optimistic lock version
    UPDATE account_versions SET version = version + 1 WHERE account_id IN (p_from_account, p_to_account);
END;
$$ LANGUAGE plpgsql;


-- ==========================================
-- 2) TOP-UP (External → User wallet)
-- ==========================================
CREATE OR REPLACE FUNCTION sp_topup(
    p_account INT,
    p_amount BIGINT,
    p_note TEXT DEFAULT 'Top-up'
)
RETURNS VOID AS $$
DECLARE
    v_balance BIGINT;
    v_tx_id INT;
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    SELECT balance INTO v_balance
    FROM accounts
    WHERE id = p_account
    FOR UPDATE;

    INSERT INTO transactions (tx_type, reference, description)
    VALUES ('TOPUP', fn_generate_reference(), p_note)
    RETURNING id INTO v_tx_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (
        v_tx_id, p_account, p_amount, v_balance + p_amount
    );

    UPDATE accounts SET balance = balance + p_amount WHERE id = p_account;

    UPDATE account_versions SET version = version + 1 WHERE account_id = p_account;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 3) PURCHASE: User wallet → Merchant account
-- ==========================================
CREATE OR REPLACE FUNCTION sp_purchase(
    p_user_account INT,
    p_merchant_account INT,
    p_amount BIGINT,
    p_description TEXT DEFAULT 'Purchase'
)
RETURNS VOID AS $$
DECLARE
    v_balance BIGINT;
    v_balance2 BIGINT;
    v_tx_id INT;
BEGIN
    SELECT balance INTO v_balance FROM accounts WHERE id = p_user_account FOR UPDATE;
    SELECT balance INTO v_balance2 FROM accounts WHERE id = p_merchant_account FOR UPDATE;

    IF v_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds';
    END IF;

    INSERT INTO transactions (tx_type, reference, description)
    VALUES ('PURCHASE', fn_generate_reference(), p_description)
    RETURNING id INTO v_tx_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (
        v_tx_id, p_user_account, -p_amount, v_balance - p_amount
    ), (
        v_tx_id, p_merchant_account, +p_amount, v_balance2 + p_amount
    );

    UPDATE accounts SET balance = balance - p_amount WHERE id = p_user_account;
    UPDATE accounts SET balance = balance + p_amount WHERE id = p_merchant_account;

    UPDATE account_versions SET version = version + 1 WHERE account_id IN (p_user_account, p_merchant_account);
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 4) REFUND: Merchant → User
-- ==========================================
CREATE OR REPLACE FUNCTION sp_refund(
    p_merchant_account INT,
    p_user_account INT,
    p_amount BIGINT,
    p_note TEXT DEFAULT 'Refund'
)
RETURNS VOID AS $$
DECLARE
    v_m_bal BIGINT;
    v_u_bal BIGINT;
    v_tx_id INT;
BEGIN
    SELECT balance INTO v_m_bal FROM accounts WHERE id = p_merchant_account FOR UPDATE;
    SELECT balance INTO v_u_bal FROM accounts WHERE id = p_user_account FOR UPDATE;

    IF v_m_bal < p_amount THEN
        RAISE EXCEPTION 'Merchant lacks refund funds';
    END IF;

    INSERT INTO transactions (tx_type, reference, description)
    VALUES ('REFUND', fn_generate_reference(), p_note)
    RETURNING id INTO v_tx_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (
        v_tx_id, p_merchant_account, -p_amount, v_m_bal - p_amount
    ), (
        v_tx_id, p_user_account, +p_amount, v_u_bal + p_amount
    );

    UPDATE accounts SET balance = balance - p_amount WHERE id = p_merchant_account;
    UPDATE accounts SET balance = balance + p_amount WHERE id = p_user_account;

    UPDATE account_versions SET version = version + 1 WHERE account_id IN (p_merchant_account, p_user_account);
END;
$$ LANGUAGE plpgsql;
