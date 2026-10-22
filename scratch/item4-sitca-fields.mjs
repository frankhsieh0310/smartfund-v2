import Papa from 'papaparse';
const res = await fetch('https://www.sitca.org.tw/MemberK0000/F/03/nav.csv', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
const text = await res.text();
const parsed = Papa.parse(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true });
console.log('Columns:', Object.keys(parsed.data[0]));
// distinct type codes among the 173 unmatched (just sample overall distinct values)
const typeCodes = new Set(parsed.data.map(r => r['類型代號']).filter(Boolean));
console.log('Distinct 類型代號 values (sample):', [...typeCodes].slice(0, 30));
console.log('Sample row:', JSON.stringify(parsed.data[100]));
