// Simple Wallet Backend (school project friendly)
// Run: NODE_ENV=development node server.js

require("dotenv").config();
const cors = require("cors");
const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
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

// ---------------------------------------------------------
// CORS CONFIG (place here) 🔥
// ---------------------------------------------------------
const allowedOrigins = [
  "http://localhost:5173",                           // local dev
  "https://simple-wallet-frontend.onrender.com",     // deployed frontend
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // Allow curl, mobile apps, etc
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);
// ---------------------------------------------------------



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
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'No token' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Invalid token' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token not valid' });
    req.user = user;
    next();
  });
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
       VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [username, hash]
    );

    let userId;
    if (r.rowCount === 0) {
      const existing = await client.query(
        "SELECT id FROM users WHERE username=$1",
        [username]
      );
      userId = existing.rows[0].id;
    } else {
      userId = r.rows[0].id;
    }

    await client.query(
      `INSERT INTO accounts (user_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
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
app.get('/me/account', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const result = await pool.query(
      'SELECT accounts.id AS account_id, users.username, accounts.balance FROM accounts JOIN users ON users.id = accounts.user_id WHERE users.id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
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
    // include tx_type to satisfy NOT NULL constraint
    const tx = await client.query(
      `INSERT INTO transactions (tx_type, reference, description)
       VALUES ($1,$2,$3)
       RETURNING id`,
      ["topup", ref, "topup"]
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

    // corrected FOR UPDATE
    const src = await client.query(
      "SELECT id, balance FROM accounts WHERE user_id=$1 FOR UPDATE",
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
    // include tx_type column
    const tx = await client.query(
      `INSERT INTO transactions (tx_type, reference, description)
       VALUES ($1,$2,$3)
       RETURNING id`,
      ["transfer", ref, "transfer"]
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

    const ref = uuidv4();
    // include tx_type and correct ref/description
    const tx = await client.query(
      `INSERT INTO transactions (tx_type, reference, description)
       VALUES ($1,$2,$3)
       RETURNING id`,
      ["purchase", ref, "purchase"]
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

app.get("/", (req, res) => {
  res.send("Simple Wallet Backend is running 🎉");
});

// quick health check (keeps external probes happy)
app.get("/health", (req, res) => {
  res.json({ ok: true, version: "simple-wallet-backend", uptime: process.uptime() });
});

app.listen(PORT, () => console.log("Server listening on", PORT));
