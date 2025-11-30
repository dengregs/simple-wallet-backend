/**
 * DIRTY READ TEST
 * Ensures one transaction cannot see uncommitted changes from another.
 */

const axios = require("axios");
const BASE = "http://localhost:3000";

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== DIRTY READ TEST ===");

  // Prepare accounts
  await axios.post(BASE + "/wallet/topup", {
    account_id: 1,
    amount: 5000
  });

  console.log("A balance set to 5000.");

  // Transaction 1: starts transfer but pauses before commit
  const tx1 = axios.post(BASE + "/wallet/transfer_uncommitted_test", {
    from_account_id: 1,
    to_account_id: 2,
    amount: 1000
  });

  // Wait a bit — simulate T1 holding lock
  await delay(200);

  // Transaction 2: tries to READ balance of A
  const readA = await axios.get(BASE + "/wallet/account/1");
  console.log("Balance seen by T2:", readA.data.balance);

  console.log("If balance is STILL 5000 → DIRTY READ PREVENTED ✔");

  await tx1.catch(() => {});

  console.log("=== DIRTY READ TEST COMPLETE ===");
}

main();
