// server.js
// Simple Wallet Backend (cleaned + single-route set)
// Run: NODE_ENV=development node server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

// DB connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : {
    require: true,
    rejectUnauthorized: false
  }
});

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());

// CORS - allow your frontend hostname (change if needed)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://simple-wallet-frontend.onrender.com";
app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true
}));
app.options("*", cors());

// --- auth middleware (single)
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "No token" });
  const parts = authHeader.split(" ");
  if (parts.length !== 2) return res.status(401).json({ error: "Invalid token" });
  const token = parts[1];

  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) return res.status(403).json({ error: "Token not valid" });
    // normalized payload keys
    req.user = {
      user_id: payload.user_id || payload.id || payload.userId,
      username: payload.username || payload.user || null
    };
    next();
  });
}

// --------------------
// AUTH ROUTES
// --------------------

// Register
app.post("/auth/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username & password required" });

  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const r = await client.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [username, hash]
    );

    let userId;
    if (r.rowCount === 0) {
      const ex = await client.query("SELECT id FROM users WHERE username=$1", [username]);
      userId = ex.rows[0].id;
    } else {
      userId = r.rows[0].id;
    }

    // ensure an accounts row exists for the user
    await client.query(
      `INSERT INTO accounts (user_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, "0"]
    );

    await client.query("COMMIT");
    res.json({ user_id: userId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: err.message || "register failed" });
  } finally {
    client.release();
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username & password required" });

  try {
    const r = await pool.query("SELECT id, password_hash FROM users WHERE username=$1", [username]);
    if (r.rowCount === 0) return res.status(401).json({ error: "invalid" });

    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid" });

    const token = jwt.sign({ user_id: user.id, username }, JWT_SECRET, { expiresIn: "8h" });
    res.json({ token, user_id: user.id });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "login failed" });
  }
});

// --------------------
// ACCOUNT / BALANCE
// --------------------
app.get("/me/account", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const result = await pool.query(
      `SELECT a.id AS account_id, u.username, a.balance
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.user_id = $1`,
      [userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "account not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /me/account error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// --------------------
// TOPUP (creates transaction + ledger entries)
// --------------------
app.post("/wallet/topup", authMiddleware, async (req, res) => {
  const { amount } = req.body || {};
  if (!amount || BigInt(amount) <= 0n) return res.status(400).json({ error: "amount required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock account
    const accRes = await client.query("SELECT id, balance FROM accounts WHERE user_id=$1 FOR UPDATE", [req.user.user_id]);
    if (accRes.rowCount === 0) throw new Error("account not found");
    const accountId = accRes.rows[0].id;
    const currentBal = BigInt(accRes.rows[0].balance || "0");
    const newBal = currentBal + BigInt(amount);

    const ref = uuidv4();
    const tx = await client.query(
      `INSERT INTO transactions (tx_type, reference, description)
       VALUES ($1, $2, $3) RETURNING id`,
      ["topup", ref, "topup"]
    );
    const txid = tx.rows[0].id;

    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [txid, accountId, amount.toString(), newBal.toString(), JSON.stringify({ type: "topup" })]
    );

    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [newBal.toString(), accountId]);

    await client.query("COMMIT");
    res.json({ account_id: accountId, balance: newBal.toString(), txid });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("TOPUP ERROR:", err);
    res.status(500).json({ error: err.message || "topup failed" });
  } finally {
    client.release();
  }
});

// --------------------
// TRANSFER
// --------------------
app.post("/wallet/transfer", authMiddleware, async (req, res) => {
  const { to_account_id, amount } = req.body || {};
  if (!to_account_id || !amount || BigInt(amount) <= 0n) return res.status(400).json({ error: "to_account_id and positive amount required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // get source account for logged user and lock
    const srcRes = await client.query("SELECT id, balance FROM accounts WHERE user_id=$1 FOR UPDATE", [req.user.user_id]);
    if (srcRes.rowCount === 0) throw new Error("source account not found");
    const fromId = srcRes.rows[0].id;

    // lock both accounts in deterministic order to avoid deadlock
    const first = Math.min(fromId, Number(to_account_id));
    const second = Math.max(fromId, Number(to_account_id));

    const a1 = await client.query("SELECT id, balance FROM accounts WHERE id=$1 FOR UPDATE", [first]);
    const a2 = await client.query("SELECT id, balance FROM accounts WHERE id=$1 FOR UPDATE", [second]);

    const fromRow = (a1.rows[0] && a1.rows[0].id === fromId) ? a1.rows[0] : a2.rows[0];
    const toRow = (a1.rows[0] && a1.rows[0].id === Number(to_account_id)) ? a1.rows[0] : a2.rows[0];

    if (!fromRow || !toRow) throw new Error("one of accounts not found");

    if (BigInt(fromRow.balance) < BigInt(amount)) throw new Error("insufficient funds");

    const newFrom = BigInt(fromRow.balance) - BigInt(amount);
    const newTo = BigInt(toRow.balance) + BigInt(amount);

    const ref = uuidv4();
    const tx = await client.query(
      `INSERT INTO transactions (tx_type, reference, description) VALUES ($1,$2,$3) RETURNING id`,
      ["transfer", ref, "transfer"]
    );
    const txid = tx.rows[0].id;

    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [txid, fromId, (-BigInt(amount)).toString(), newFrom.toString(), JSON.stringify({ counterparty: to_account_id })]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [txid, Number(to_account_id), BigInt(amount).toString(), newTo.toString(), JSON.stringify({ counterparty: fromId })]
    );

    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [newFrom.toString(), fromId]);
    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [newTo.toString(), Number(to_account_id)]);

    await client.query("COMMIT");

    res.json({ txid, from: { id: fromId, balance: newFrom.toString() }, to: { id: Number(to_account_id), balance: newTo.toString() } });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("TRANSFER ERROR:", err);
    res.status(500).json({ error: err.message || "transfer failed" });
  } finally {
    client.release();
  }
});

// --------------------
// PURCHASE (merchant)
 // --------------------
app.post("/wallet/purchase", authMiddleware, async (req, res) => {
  const { merchant_id, amount } = req.body || {};
  const userId = req.user.user_id;
  if (!merchant_id || !amount || BigInt(amount) <= 0n) return res.status(400).json({ error: "Invalid merchant or amount" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const buyer = await client.query("SELECT id, balance FROM accounts WHERE user_id=$1 FOR UPDATE", [userId]);
    if (buyer.rowCount === 0) throw new Error("Buyer account not found");
    const buyerAcc = buyer.rows[0];

    if (BigInt(buyerAcc.balance) < BigInt(amount)) throw new Error("Insufficient funds");

    const merch = await client.query("SELECT id, balance FROM accounts WHERE id=$1 FOR UPDATE", [merchant_id]);
    if (merch.rowCount === 0) throw new Error("Merchant account not found");
    const merchAcc = merch.rows[0];

    const newBuyerBal = BigInt(buyerAcc.balance) - BigInt(amount);
    const newMerchBal = BigInt(merchAcc.balance) + BigInt(amount);

    const ref = uuidv4();
    const tx = await client.query(`INSERT INTO transactions (tx_type, reference, description) VALUES ($1,$2,$3) RETURNING id`, ["purchase", ref, "purchase"]);
    const txid = tx.rows[0].id;

    await client.query(`INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after, metadata) VALUES ($1,$2,$3,$4,$5)`,
      [txid, buyerAcc.id, (-BigInt(amount)).toString(), newBuyerBal.toString(), JSON.stringify({ merchant: merchant_id })]);

    await client.query(`INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after, metadata) VALUES ($1,$2,$3,$4,$5)`,
      [txid, Number(merchant_id), BigInt(amount).toString(), newMerchBal.toString(), JSON.stringify({ customer: buyerAcc.id })]);

    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [newBuyerBal.toString(), buyerAcc.id]);
    await client.query("UPDATE accounts SET balance=$1 WHERE id=$2", [newMerchBal.toString(), Number(merchant_id)]);

    await client.query("COMMIT");
    res.json({ success: true, txid });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PURCHASE ERROR:", err);
    res.status(500).json({ error: err.message || "purchase failed" });
  } finally {
    client.release();
  }
});

// --------------------
// LEDGER (recent entries for current user)
// --------------------
app.get("/wallet/ledger", authMiddleware, async (req, res) => {
  try {
    const q = `
      SELECT le.id, le.transaction_id, le.amount, le.balance_after, le.metadata, le.created_at
      FROM ledger_entries le
      JOIN accounts a ON le.account_id = a.id
      WHERE a.user_id = $1
      ORDER BY le.created_at DESC
      LIMIT 200
    `;
    const r = await pool.query(q, [req.user.user_id]);
    res.json(r.rows);
  } catch (err) {
    console.error("LEDGER ERROR:", err);
    res.status(500).json({ error: "failed to fetch ledger" });
  }
});

// root + health
app.get("/", (req, res) => res.send("Simple Wallet Backend is running 🎉"));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));