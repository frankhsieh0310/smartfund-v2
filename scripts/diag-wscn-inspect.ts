import * as fs from "fs";
const j = JSON.parse(fs.readFileSync(process.env.WSCN_PATH!, "utf8"));
const items = j.data.items;
console.log("total", items.length);
console.log("score distribution", JSON.stringify(items.reduce((a: any, i: any) => { a[i.score] = (a[i.score] || 0) + 1; return a; }, {})));
const important = items.filter((i: any) => i.score >= 2);
console.log("important count", important.length);
for (const it of important.slice(0, 6)) {
  console.log(JSON.stringify({ id: it.id, title: it.title, score: it.score, channels: it.channels, symbols: it.symbols, display_time: it.display_time, uri: it.uri }));
}
const allChannels = new Set<string>();
items.forEach((i: any) => i.channels.forEach((c: string) => allChannels.add(c)));
console.log("all channels seen", JSON.stringify([...allChannels]));
