/*
Simple concurrency test:
- Register two users A and B
- Topup A with some balance
- Fire concurrent transfers from A to B
*/
const axios = require('axios');
const BASE = process.env.BASE || 'http://localhost:3000';
const NUM = 30;
const PARALLEL = 10;

async function registerIfNeeded(username, password) {
  try {
    await axios.post(BASE + '/auth/register', { username, password });
  } catch (e) {
    // ignore
  }
  const r = await axios.post(BASE + '/auth/login', { username, password });
  return r.data.token;
}

(async () => {
  try {
    const tokenA = await registerIfNeeded('userA', 'passA');
    const tokenB = await registerIfNeeded('userB', 'passB');
    // get account ids
    const meA = await axios.get(BASE + '/me/account', { headers: { authorization: 'Bearer ' + tokenA } });
    const meB = await axios.get(BASE + '/me/account', { headers: { authorization: 'Bearer ' + tokenB } });
    const aid = meA.data.id;
    const bid = meB.data.id;
    console.log('accounts', aid, bid);
    // topup A
    await axios.post(BASE + '/wallet/topup', { amount: 100000 }, { headers: { authorization: 'Bearer ' + tokenA } });
    // concurrent transfers
    const tasks = [];
    for (let i=0;i<NUM;i++) {
      tasks.push(axios.post(BASE + '/wallet/transfer', { to_account_id: bid, amount: 1000 }, { headers: { authorization: 'Bearer ' + tokenA } }).catch(e=>e.response?e.response.data:e.message));
      if (tasks.length >= PARALLEL) {
        const r = await Promise.allSettled(tasks);
        tasks.length = 0;
      }
    }
    console.log('done');
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
  }
})();
