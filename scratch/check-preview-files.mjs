import { readFileSync } from 'node:fs';
const token = JSON.parse(readFileSync(process.env.APPDATA + '/com.vercel.cli/Data/auth.json', 'utf8')).token;
const res = await fetch('https://api.vercel.com/v6/deployments/dpl_8aCxZisbUgF7KgMQg3qBtdP1sTcw/files', { headers: { Authorization: `Bearer ${token}` } });
const j = await res.json();
const targets = ['congress-trades', 'insider-trades', 'institutional-holdings', 'movement-radar', 'consensus-ingest', 'yahoo-etf-full-sweep', 'yahoo-fund-full-sweep', 'workflows/bootstrap', 'api/consensus'];
const found = new Set();
function walk(nodes, prefix) {
  for (const n of nodes ?? []) {
    const p = prefix + '/' + n.name;
    if (n.type === 'directory' && n.children) walk(n.children, p);
    else for (const t of targets) if (p.includes(t)) found.add(t);
  }
}
walk(j, '');
console.log('found targets:', [...found]);
console.log('missing targets:', targets.filter((t) => !found.has(t)));
