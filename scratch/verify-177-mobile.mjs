import fs from 'node:fs';
const newFunds = JSON.parse(fs.readFileSync('scratch/item4-newfunds-final.json', 'utf8'));
const newIds = new Set(newFunds.map(f => f.id));

const res = await fetch('https://smartfund-v2.vercel.app/api/mobile/current-market-data?scope=all&asset=FUND');
const json = await res.json();
const rows = json.data?.funds ?? [];
console.log(`Mobile API total funds: ${rows.length} (expect 5634+177=5811)`);

const liveIds = new Set(rows.map(r => r.fundId));
const extraVsNew = [...liveIds].filter(id => newIds.has(id));
console.log(`New-fund ids found in mobile API: ${extraVsNew.length}/177`);

// spot check a few
for (const f of newFunds.slice(0, 5)) {
  const m = rows.find(r => r.fundId === f.id);
  console.log(`${f.code}: ${m ? `category=${m.fundType}, currency=${m.currency}, nav=${m.nav}` : 'NOT FOUND'}`);
}
