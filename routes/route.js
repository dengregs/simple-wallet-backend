const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db");

// ============================
// REGISTER USER
// ============================
router.post("/register", async (req, res) => {
  try {
    const { username, firstName, lastName, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      `INSERT INTO users (username, first_name, last_name, email, password)
       VALUES ($1, $2, $3, $4, $5)`,
      [username, firstName, lastName, email, hashedPassword]
    );

    res.json({ message: "User registered successfully!" });

  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================
// REVERSE TRANSACTION
// ============================
router.post("/wallet/reverse/:transaction_id", async (req, res) => {
  const { transaction_id } = req.params;

  try {
    await pool.query("CALL sp_reverse_transaction($1)", [transaction_id]);

    res.json({
      success: true,
      message: `Transaction ${transaction_id} reversed successfully.`,
    });
  } catch (err) {
    console.error("Reverse error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============================
// BUY FROM MERCHANT
// ============================
router.post("/wallet/buy", async (req, res) => {
  const client = await pool.connect();

  try {
    const { user_account_id, merchant_account_id, amount, item_name } = req.body;

    if (!user_account_id || !merchant_account_id || !amount) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    await client.query("BEGIN");

    // 1. Create transaction
    const tx = await client.query(
      `INSERT INTO transactions (type, reference)
       VALUES ('purchase', $1)
       RETURNING id`,
      [item_name || "merchant_purchase"]
    );

    const txId = tx.rows[0].id;

    // 2. Debit user
    const debit = await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after, metadata)
       VALUES (
         $1, $2, -$3,
         (SELECT balance - $3 FROM accounts WHERE id = $2),
         jsonb_build_object('action', 'buy_from_merchant', 'item', $4)
       )
       RETURNING id`,
      [txId, user_account_id, amount, item_name]
    );

    // 3. Credit merchant
    const credit = await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after, metadata)
       VALUES (
         $1, $2, $3,
         (SELECT balance + $3 FROM accounts WHERE id = $2),
         jsonb_build_object('action', 'merchant_receive', 'item', $4)
       )
       RETURNING id`,
      [txId, merchant_account_id, amount, item_name]
    );

    // 4. Update account balances
    await client.query(
      `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
      [amount, user_account_id]
    );

    await client.query(
      `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
      [amount, merchant_account_id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Purchase completed successfully!",
      transaction_id: txId,
      debit_entry: debit.rows[0],
      credit_entry: credit.rows[0],
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Buy error:", err);
    res.status(400).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
