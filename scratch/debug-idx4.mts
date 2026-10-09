import { readFileSync } from 'node:fs';
const items = JSON.parse(readFileSync('scratch/attributed-items.json', 'utf8'));
const item = items[4];
const hay = `${item.title}\n${item.text}`;

const SAY_VERBS_LIST = ["said", "says", "say", "told", "adds", "add", "added", "wrote", "writes", "noted", "argued", "warned", "stated", "remarked", "explained", "commented", "testified", "announced"];
const INVERTIBLE_VERBS = SAY_VERBS_LIST.filter((v) => v !== 'told' && v !== 'tells');
const NAME_TOKEN = "[A-Z][A-Za-z.'\\-]+(?:\\s+[A-Z][A-Za-z.'\\-]+){0,3}";
const reNameVerb = new RegExp(`(${NAME_TOKEN})\\s+(?:${SAY_VERBS_LIST.join('|')})\\b`, 'g');
const reVerbName = new RegExp(`\\b(?:${INVERTIBLE_VERBS.join('|')})\\s+(${NAME_TOKEN})`, 'g');
const reAccording = new RegExp(`according to\\s+(${NAME_TOKEN})`, 'gi');
const reDash = /[-–—]\s*(?:by\s+)?([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,3})/g;
const spans = [];
let m;
while ((m = reNameVerb.exec(hay))) spans.push({ index: m.index, name: m[1] });
while ((m = reVerbName.exec(hay))) spans.push({ index: m.index, name: m[1] });
while ((m = reAccording.exec(hay))) spans.push({ index: m.index, name: m[1] });
while ((m = reDash.exec(hay))) spans.push({ index: m.index, name: m[1] });
console.log('spans found:', spans.length);
spans.forEach((s) => console.log(' span', s.index, JSON.stringify(s.name)));

const QUOTE = /["“”„«»]/g;
let qm;
const quoteIdxs = [];
while ((qm = QUOTE.exec(hay))) quoteIdxs.push(qm.index);
console.log('quote marks at:', quoteIdxs);

for (const qi of quoteIdxs) {
  let nearest = null, nearestDist = Infinity;
  for (const span of spans) {
    const dist = Math.abs(span.index - qi);
    if (dist <= 80 && dist < nearestDist) { nearest = span; nearestDist = dist; }
  }
  if (nearest) console.log(`quote@${qi} -> nearest span "${nearest.name}" @${nearest.index} dist=${nearestDist} context="${hay.slice(Math.max(0,qi-40),qi+40)}"`);
}
