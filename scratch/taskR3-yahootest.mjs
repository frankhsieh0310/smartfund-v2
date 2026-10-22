const q = encodeURIComponent(JSON.stringify({ onshore: "2", q: "富蘭克林坦伯頓", limit: 10 }));
const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${q}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop`;
const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
console.log('status:', res.status);
const text = await res.text();
console.log(text.slice(0, 500));
