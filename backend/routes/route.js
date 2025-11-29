const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db"); // adjust if your DB file is in different location

// REGISTER USER
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
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
