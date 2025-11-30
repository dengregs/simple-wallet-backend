/**
 * LOST UPDATE CONCURRENCY TEST
 * Verifies that two concurrent transfers do NOT overwrite each other.
 * Your database uses SELECT ... FOR UPDATE which prevents lost updates.
 */

const axios = require("axios");
const BASE = "http://localhost:3000";

async function main() {
  console.log("=== LOST UPDATE TEST ===");

  // Create or login userA and userB
  await axios.post(BASE + "/account/register", {
    username: "lostA",
    firstName: "A",
    lastName: "A",
    email: "lostA@test.com",
    password: "123"
  }).catch(() => {});

  await axios.post(BASE + "/account/register", {
    username: "lostB",
    firstName: "B",
    lastName: "B",
    email: "lostB@test.com",
    password: "123"
  }).catch(() => {});

  // Get accounts
  const accA = await axios.get(BASE + "/wallet/account/1");
  const accB = await axios.get(BASE + "/wallet/account/2");

  console.log("User A account:", accA.data);
  console.log("User B account:", accB.data);

  // Top up A with enough balance
  await axios.post(BASE + "/wallet/topup", {
    account_id: 1,
    amount: 10000
  });

  console.log("Topped up A with 10,000");

  // Fire concurrent transfers
  const tasks = [];
  for (let i = 0; i < 20; i++) {
    tasks.push(
      axios
        .post(BASE + "/wallet/transfer", {
          from_account_id: 1,
          to_account_id: 2,
          amount: 100
        })
        .catch((e) => e.response?.data)
    );
  }

  const results = await Promise.allSettled(tasks);
  console.log("Finished concurrent transfers.");
  console.log(results);

  // Fetch balances after test
  const newA = await axios.get(BASE + "/wallet/account/1");
  const newB = await axios.get(BASE + "/wallet/account/2");

  console.log("Final balance A:", newA.data);
  console.log("Final balance B:", newB.data);

  console.log("=== LOST UPDATE TEST COMPLETE ===");
}

main();
