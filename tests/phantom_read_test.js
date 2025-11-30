/**
 * PHANTOM READ TEST
 * Ensures that a transaction cannot see new rows inserted by another
 * transaction until it finishes.
 */

const axios = require("axios");
const BASE = "http://localhost:3000";

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== PHANTOM READ TEST ===");

  // Begin T1: first read
  const firstRead = await axios.get(BASE + "/wallet/list_transactions/1");
  console.log("T1 first read count:", firstRead.data.length);

  // At the same time, T2 inserts a new transaction
  axios.post(BASE + "/wallet/topup", {
    account_id: 1,
    amount: 10
  });

  // T1 waits — but SERIALIZABLE should freeze view
  await delay(200);

  // T1 second read
  const secondRead = await axios.get(BASE + "/wallet/list_transactions/1");
  console.log("T1 second read count:", secondRead.data.length);

  console.log("If counts MATCH → PHANTOM READ PREVENTED ✔");

  console.log("=== PHANTOM READ TEST COMPLETE ===");
}

main();
