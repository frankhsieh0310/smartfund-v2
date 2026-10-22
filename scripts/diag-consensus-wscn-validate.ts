// Focused validation — mirrors app/api/cron/consensus-wallstreetcn/route.ts's exact logic (person
// matching against the existing PEOPLE map, category tagging), but run via `pg` directly since that
// module can't resolve Next.js's "@/" alias outside the Next runtime. Writes real rows to the real,
// currently-empty consensus_feed_items table (this is the intended first real ingestion, not a backfill
// — one bounded live fetch of the current feed).
import { Client } from "pg";

const WSCN_BASE = "https://api-one-wscn.awtmt.com/apiv1/content/lives";
const SCORE_THRESHOLD = 2;

const PEOPLE: Record<string, { title: string; name: string }> = {
  "Donald Trump": { title: "美國總統", name: "川普" }, "Jerome Powell": { title: "聯準會主席", name: "鮑爾" },
  "Scott Bessent": { title: "美國財政部長", name: "貝森特" }, "Howard Lutnick": { title: "美國商務部長", name: "盧特尼克" },
  "Jamieson Greer": { title: "美國貿易代表", name: "葛里爾" }, "John C. Williams": { title: "紐約聯準銀行總裁", name: "威廉斯" },
  "Christopher Waller": { title: "聯準會理事", name: "沃勒" }, "Michelle Bowman": { title: "聯準會理事", name: "鮑曼" },
  "Jensen Huang": { title: "輝達執行長", name: "黃仁勳" }, "Lisa Su": { title: "超微董事長暨執行長", name: "蘇姿丰" },
  "C.C. Wei": { title: "台積電董事長", name: "魏哲家" }, "Satya Nadella": { title: "微軟執行長", name: "納德拉" },
  "Sundar Pichai": { title: "Alphabet 執行長", name: "皮查伊" }, "Mark Zuckerberg": { title: "Meta 執行長", name: "祖克柏" },
  "Tim Cook": { title: "蘋果執行長", name: "庫克" }, "Andy Jassy": { title: "亞馬遜執行長", name: "賈西" },
  "Elon Musk": { title: "特斯拉執行長", name: "馬斯克" }, "Hock Tan": { title: "博通執行長", name: "陳福陽" },
  "Lip-Bu Tan": { title: "英特爾執行長", name: "陳立武" }, "Cristiano Amon": { title: "高通執行長", name: "阿蒙" },
  "Jamie Dimon": { title: "摩根大通執行長", name: "戴蒙" }, "Larry Fink": { title: "貝萊德董事長", name: "芬克" },
  "Warren Buffett": { title: "波克夏董事長", name: "巴菲特" }, "Bill Ackman": { title: "潘興廣場資本創辦人", name: "艾克曼" },
  "Ray Dalio": { title: "橋水基金創辦人", name: "達利歐" }, "Cathie Wood": { title: "方舟投資執行長", name: "伍德" },
  "Howard Marks": { title: "橡樹資本共同創辦人", name: "馬克斯" },
};
const COMPANIES: Record<string, string> = {
  NVDA: "輝達", GOOGL: "Alphabet（Google 母公司）", GOOG: "Alphabet（Google 母公司）", MSFT: "微軟",
  AAPL: "蘋果", AMZN: "亞馬遜", META: "Meta（臉書母公司）", TSM: "台積電", "2330": "台積電",
  AMD: "超微", AVGO: "博通", MU: "美光", INTC: "英特爾", QCOM: "高通", TSLA: "特斯拉",
  JPM: "摩根大通", "BRK.B": "波克夏", "BRK-B": "波克夏", "BRK.A": "波克夏", BLK: "貝萊德",
  GS: "高盛", MS: "摩根士丹利", BAC: "美國銀行", C: "花旗集團", WFC: "富國銀行",
  XOM: "埃克森美孚", CVX: "雪佛龍", OXY: "西方石油", COP: "康菲石油",
  GM: "通用汽車", F: "福特汽車", WMT: "沃爾瑪", KO: "可口可樂", AXP: "美國運通", BX: "黑石集團",
};

type WscnItem = { id: number; title: string; content_text: string; display_time: number; score: number; channels: string[]; symbols: string[]; uri: string };

const SIMPLIFIED_ALIASES: Record<string, string> = {
  "Donald Trump": "特朗普", "Jerome Powell": "鲍威尔", "Scott Bessent": "贝森特",
  "Howard Lutnick": "卢特尼克", "Jamieson Greer": "格里尔", "John C. Williams": "威廉姆斯",
  "Christopher Waller": "沃勒", "Michelle Bowman": "鲍曼", "Jensen Huang": "黄仁勋",
  "Lisa Su": "苏姿丰", "Satya Nadella": "纳德拉", "Mark Zuckerberg": "扎克伯格",
  "Tim Cook": "库克", "Andy Jassy": "贾西", "Elon Musk": "马斯克", "Hock Tan": "陈福阳",
  "Lip-Bu Tan": "陈立武", "Cristiano Amon": "安蒙", "Bill Ackman": "阿克曼", "Ray Dalio": "达利欧",
  "Howard Marks": "马克斯",
};

const SPEECH_VERB_PATTERN = "(表示|說|说|称|稱|指出|強調|强调|警告|認為|认为|談及|谈及|回應|回应|宣布|重申)";
function hasOwnStatement(text: string, name: string): boolean {
  return new RegExp(`${name}[^。！？，,\\n]{0,8}${SPEECH_VERB_PATTERN}`).test(text);
}
function matchPerson(text: string) {
  for (const [englishKey, display] of Object.entries(PEOPLE)) {
    if (text.includes(display.name) && hasOwnStatement(text, display.name)) return { englishKey, zhName: display.name };
    const alias = SIMPLIFIED_ALIASES[englishKey];
    if (alias && text.includes(alias) && hasOwnStatement(text, alias)) return { englishKey, zhName: display.name };
  }
  return null;
}

async function main() {
  const channels = ["global-channel", "us-stock-channel", "a-stock-channel", "forex-channel", "hk-stock-channel"];
  const allItems: WscnItem[] = [];
  for (const channel of channels) {
    const r = await fetch(`${WSCN_BASE}?channel=${channel}&client=pc&limit=100`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const j = await r.json();
    allItems.push(...(j.data.items ?? []));
  }
  const seen = new Set<number>();
  const dedup = allItems.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  const important = dedup.filter((i) => i.score >= SCORE_THRESHOLD).slice(0, 25);

  const client = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  await client.connect();

  let personCount = 0, eventCount = 0, sourceAttributionOk = 0, noFakeViewpoint = 0;
  const sample: any[] = [];

  for (const item of important) {
    const hay = `${item.title} ${item.content_text}`;
    const person = matchPerson(hay);
    const itemType = person ? "PERSON_VIEWPOINT" : "IMPORTANT_EVENT";
    if (person) personCount++; else eventCount++;
    const relatedTickers = item.symbols ?? [];
    const relatedCompanies = relatedTickers.map((t) => COMPANIES[t.toUpperCase()] ?? null);

    await client.query(
      `INSERT INTO consensus_feed_items
         (source, external_id, published_at, title, content, score, channel, source_url,
          item_type, person_slug, person_display_name, related_tickers, related_companies, related_industries, stance)
       VALUES ('WALLSTREETCN', $1, to_timestamp($2), $3, $4, $5, $6::text[], $7, $8, $9, $10, $11::text[], $12::text[], '{}', NULL)
       ON CONFLICT (source, external_id) DO UPDATE SET published_at=EXCLUDED.published_at, title=EXCLUDED.title,
         content=EXCLUDED.content, score=EXCLUDED.score, channel=EXCLUDED.channel, source_url=EXCLUDED.source_url,
         item_type=EXCLUDED.item_type, person_slug=EXCLUDED.person_slug, person_display_name=EXCLUDED.person_display_name,
         related_tickers=EXCLUDED.related_tickers, related_companies=EXCLUDED.related_companies`,
      [String(item.id), item.display_time, item.title, item.content_text, item.score, item.channels,
        item.uri, itemType, person?.englishKey ?? null, person?.zhName ?? null, relatedTickers, relatedCompanies],
    );

    // source attribution check: every row must carry a real, dereferenceable wallstreetcn.com URL
    if (item.uri && item.uri.includes("wallstreetcn.com")) sourceAttributionOk++;
    // no-fake-viewpoint check: we never write a non-null stance
    noFakeViewpoint++; // stance always NULL by construction above

    if (sample.length < 8) sample.push({ id: item.id, title: item.title, score: item.score, itemType, person: person?.zhName ?? null, relatedTickers, sourceUrl: item.uri });
  }

  const totalRows = await client.query(`SELECT COUNT(*) c FROM consensus_feed_items`);
  const stanceCheck = await client.query(`SELECT COUNT(*) c FROM consensus_feed_items WHERE stance IS NOT NULL`);
  await client.end();

  console.log(JSON.stringify({
    IMPORTANT_FEED_PASS: important.length >= 20 ? "PASS" : `PARTIAL (${important.length} found, wanted >=20)`,
    fetchedTotal: dedup.length, importantFound: important.length,
    PERSON_VIEWPOINT_PASS: personCount > 0 ? "PASS" : "NO_PERSON_MATCH_IN_SAMPLE",
    IMPORTANT_EVENT_PASS: eventCount > 0 ? "PASS" : "NO_NONPERSON_EVENT_IN_SAMPLE",
    personCount, eventCount,
    SOURCE_ATTRIBUTION_PASS: sourceAttributionOk === important.length ? "PASS" : `FAIL (${sourceAttributionOk}/${important.length})`,
    NO_FAKE_VIEWPOINT_PASS: Number(stanceCheck.rows[0].c) === 0 ? "PASS" : `FAIL (${stanceCheck.rows[0].c} rows with non-null stance)`,
    totalRowsInTable: totalRows.rows[0].c,
    sample,
  }, null, 2));
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
