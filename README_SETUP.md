# Simple Wallet/Ledger Project — Setup & Deployment (Step-by-step)

This project is a minimal, easy-to-run implementation of a high-concurrency wallet + ledger for school projects.
It includes a backend (Node.js + Express), a PostgreSQL schema, and a very simple frontend (HTML + JS).
Authentication is simple username/password with JWT. Designed to be deployed to Render.com or run locally for testing.

---
## Quick overview of folders
- `backend/` : Node.js Express API
- `db/schema.sql` : SQL schema for users, accounts, transactions, ledger_entries + triggers
- `frontend/` : Simple HTML + JavaScript UI to interact with the API
- `tests/` : simple concurrency test script (Node.js)

---
## 1) Create cloud Postgres (Neon / Supabase / Railway)
Recommended: Neon (free). Alternates: Supabase, Railway.

1. Sign up and create a PostgreSQL database.
2. Copy the connection string (format: `postgres://USER:PASS@HOST:PORT/DBNAME`).
3. Keep it secret; you will use it in Render's environment variables or a `.env` locally for testing.

---
## 2) Apply the database schema
Use `psql` locally or the provider's SQL tool.

```bash
# If you have psql and DATABASE_URL set:
psql "$DATABASE_URL" -f db/schema.sql
```

Or open `db/schema.sql` and run it in the SQL console of your provider.

---
## 3) Configure backend environment
Create a `.env` file in `backend/` with:

```
DATABASE_URL=postgres://USER:PASS@HOST:PORT/DBNAME
JWT_SECRET=some_long_random_string
PORT=3000
```

(If deploying to Render, set these as environment variables in the Render service settings instead.)

---
## 4) Install and run backend locally (optional)
```bash
cd backend
npm install
npm run start
# Server runs on http://localhost:3000 by default
```

---
## 5) Use the frontend locally
Open `frontend/index.html` in your browser. The frontend expects the API base URL to be configured at the top of the file (default is `http://localhost:3000`). If you deployed to Render, change the `API_BASE` variable to the Render URL.

---
## 6) Deploy to Render (one simple option)
1. Create a GitHub repo and push this project.
2. Sign in to https://render.com and create a new **Web Service**.
3. Connect your GitHub repo and select `backend/` root.
4. Set build and start commands:
   - Build command: `npm install`
   - Start command: `npm start`
5. Add environment variables in Render: `DATABASE_URL`, `JWT_SECRET`, `PORT` (3000).
6. After deploy, get the `https://your-service.onrender.com` URL. Update `frontend/index.html` `API_BASE` to this URL and host the frontend (you can open the file locally or host HTML on GitHub Pages).

---
## 7) Run concurrency tests
```bash
cd tests
npm install
node concurrency_test.js
```

---
## Notes & Safety
- Do not expose your DB credentials publicly. Use environment variables.
- For presentation, Local run + local DB (Docker-compose) is OK — but your instructor required online availability, so use Render + cloud Postgres.
- This project enforces double-entry ledger and uses `SELECT FOR UPDATE` to avoid race conditions.
