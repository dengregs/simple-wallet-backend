// Simple Wallet Backend (school project friendly)
// Run: NODE_ENV=development node server.js

require("dotenv").config();
const cors = require("cors");
const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false
  }
});



const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());
app.use(cors());

// ======================================================
// OPTIONAL ROUTER — if you later add routes/auth.js
// ======================================================

// TRY to load routes/auth.js if it exists
try {
  const authRoutes = require("./routes/auth");
  app.use("/auth", authRoutes);
  console.log("Loaded routes/auth.js");
} catch (e) {
  console.log("No routes/auth.js found — using inline auth routes.");
}

// ======================================================
// AUTH MIDDLEWARE
// ======================================================
function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: "missing auth" });

  const token = h.replace("Bearer ", "").trim();

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "invalid token" });
  }
}

// ======================================================
// INLINE AUTH ROUTES (used if routes/auth.js is missing)
// ======================================================

// REGISTER
app.post("/auth/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "username and password required" });

  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const r = await client.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1,$2)
       ON CONFLICT ON CONSTRAINT users_username_unique DO NOTHING
       RETURNING id`,
      [username, hash]
    );

    let userId;
    if (r.rowCount === 0) {
      const existing = await client.query("SELECT id FROM users WHERE username=$1", [username]);
      userId = existing.rows[0].id;
    } else {
      userId = r.rows[0].id;
    }

    await client.query(
      `INSERT INTO accounts (user_id, balance)
       VALUES ($1, $2)
       ON CONFLICT ON CONSTRAINT accounts_user_id_key DO NOTHING`,
      [userId, 0]
    );

    await client.query("COMMIT");
    res.json({ user_id: userId });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "username & password required" });

  const r = await pool.query("SELECT id, password_hash FROM users WHERE username=$1", [username]);
  if (r.rowCount === 0) return res.status(401).json({ error: "invalid" });

  const user = r.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid" });

  const token = jwt.sign(
    { user_id: user.id, username },
    JWT_SECRET,
    { expiresIn: "8h" }
  );

  res.json({ token, user_id: user.id });
});

// ======================================================
// GET ACCOUNT
// ======================================================
app.get("/me/account", authMiddleware, async (req, res) => {
  const r = await pool.query(
    "SELECT id, balance FROM accounts WHERE user_id=$1",
    [req.user.user_id]
  );

  if (r.rowCount === 0)
    return res.status(404).json({ error: "account not found" });

  res.json(r.rows[0]);
});

// ======================================================
// TOP-UP
// ======================================================
app.post("/wallet/topup", authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0)
    return res.status(400).json({ error: "amount required" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const acc = await client.query(
      "SELECT id, balance FROM accounts WHERE user_id=$1 FOR UPDATE",
      [req.user.user_id]
    );

    if (acc.rowCount === 0)
      throw new Error("account not found");

    const accountId = acc.rows[0].id;
    const newBalance = BigInt(acc.rows[0].balance) + BigInt(amount);

    const ref = uuidv4();
    const tx = await client.query(
      `INSERT INTO transactions (reference, description)
       VALUES ($1,$2)
       RETURNING id`,
      [ref, "topup"]
    );

    const txid = tx.rows[0].id;

    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [txid, accountId, amount, newBalance.toString(), JSON.stringify({ type: "topup" })]
    );

    await client.query(
      "UPDATE accounts SET balance=$1 WHERE id=$2",
      [newBalance.toString(), accountId]
    );

    await client.query("COMMIT");

    res.json({ account_id: accountId, balance: newBalance.toString(), txid });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ======================================================
// TRANSFER
// ======================================================
app.post("/wallet/transfer", authMiddleware, async (req, res) => {
  const { to_account_id, amount } = req.body;

  if (!to_account_id || !amount || amount <= 0)
    return res.status(400).json({ error: "to_account_id and positive amount required" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const src = await client.query(
      "SELECT id, balance FROM accounts WHERE user_id=$1 FOR_UPDATE",
      [req.user.user_id]
    );

    if (src.rowCount === 0)
      throw new Error("source account not found");

    const fromId = src.rows[0].id;

    const first = Math.min(fromId, to_account_id);
    const second = Math.max(fromId, to_account_id);

    const a1 = await client.query("SELECT id, balance FROM accounts WHERE id=$1 FOR UPDATE", [first]);
    const a2 = await client.query("SELECT id, balance FROM accounts WHERE id=$1 FOR UPDATE", [second]);

    const fromRow = (a1.rows[0].id === fromId) ? a1.rows[0] : a2.rows[0];
    const toRow = (a1.rows[0].id === to_account_id) ? a1.rows[0] : a2.rows[0];

    if (!fromRow || !toRow)
      throw new Error("one of accounts not found");

    if (BigInt(fromRow.balance) < BigInt(amount))
      throw new Error("insufficient funds");

    const newFrom = BigInt(fromRow.balance) - BigInt(amount);
    const newTo = BigInt(toRow.balance) + BigInt(amount);

    const ref = uuidv4();
    const tx = await client.query(
      `INSERT INTO transactions (reference, description)
       VALUES ($1,$2)
       RETURNING id`,
      [ref, "transfer"]
    );

    const txid = tx.rows[0].id;

    await client.query(
      `INSERT INTO ledger_entries
       (transaction_id, account_id, amount, balance_after, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [txid, fromId, -Math.abs(amount), newFrom.toString(), JSON.stringify({ counterparty: to_account_id })]
    );

    await client.query(
      `INSERT INTO ledger_entries
       (transaction_id, account_id, amount, balance_after, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [txid, to_account_id, Math.abs(amount), newTo.toString(), JSON.stringify({ counterparty: fromId })]
    );

    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [newFrom.toString(), fromId]);
    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [newTo.toString(), to_account_id]);

    await client.query("COMMIT");

    res.json({
      txid,
      from: { id: fromId, balance: newFrom.toString() },
      to: { id: to_account_id, balance: newTo.toString() }
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ======================================================
// PURCHASE
// ======================================================
app.post("/wallet/purchase", authMiddleware, async (req, res) => {
  const { merchant_id, amount } = req.body;
  const userId = req.user.user_id;

  if (!merchant_id || !amount || amount <= 0)
    return res.status(400).json({ error: "Invalid merchant or amount" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const buyer = await client.query(
      "SELECT id, balance FROM accounts WHERE user_id=$1 FOR UPDATE",
      [userId]
    );

    if (buyer.rowCount === 0)
      throw new Error("Buyer account not found");

    const buyerAcc = buyer.rows[0];

    if (BigInt(buyerAcc.balance) < BigInt(amount))
      throw new Error("Insufficient funds");

    const merch = await client.query(
      "SELECT id, balance FROM accounts WHERE id=$1 FOR UPDATE",
      [merchant_id]
    );

    if (merch.rowCount === 0)
      throw new Error("Merchant account not found");

    const merchAcc = merch.rows[0];

    const newBuyerBal = BigInt(buyerAcc.balance) - BigInt(amount);
    const newMerchBal = BigInt(merchAcc.balance) + BigInt(amount);

    const tx = await client.query(
      `INSERT INTO transactions (reference, description)
       VALUES ($1,$2)
       RETURNING id`,
      [uuidv4(), "purchase"]
    );

    const txid = tx.rows[0].id;

    await client.query(
      `INSERT INTO ledger_entries
       (transaction_id, account_id, amount, balance_after, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        txid,
        buyerAcc.id,
        -Math.abs(amount),
        newBuyerBal.toString(),
        JSON.stringify({ merchant: merchant_id })
      ]
    );

    await client.query(
      `INSERT INTO ledger_entries
       (transaction_id, account_id, amount, balance_after, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        txid,
        merchant_id,
        Math.abs(amount),
        newMerchBal.toString(),
        JSON.stringify({ customer: buyerAcc.id })
      ]
    );

    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [
      newBuyerBal.toString(),
      buyerAcc.id
    ]);

    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [
      newMerchBal.toString(),
      merchant_id
    ]);

    await client.query("COMMIT");

    res.json({ success: true, txid });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("PURCHASE ERROR:", e);
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ======================================================
// LEDGER
// ======================================================
app.get("/wallet/ledger", authMiddleware, async (req, res) => {
  const r = await pool.query(
    `SELECT le.id, le.transaction_id, le.amount, le.balance_after, le.metadata, le.created_at
     FROM ledger_entries le
     JOIN accounts a ON le.account_id=a.id
     WHERE a.user_id=$1
     ORDER BY le.created_at DESC
     LIMIT 200`,
    [req.user.user_id]
  );

  res.json(r.rows);
});

// ======================================================
// START SERVER
// ======================================================
app.listen(PORT, () => console.log("Server listening on", PORT));
