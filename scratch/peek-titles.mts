import { fetchSourceCandidates } from '../lib/consensus/sourceFetch';
for (const slug of ['wallstreetcn', 'economic-daily-news', 'cnbc']) {
  const src = { id: 'x', slug, source_type: 'AGGREGATOR', source_name: 'x', source_grade: 'C' as const, canonical_url: slug === 'wallstreetcn' ? 'https://dedicated.wallstreetcn.com/rss.xml' : slug === 'economic-daily-news' ? 'https://money.udn.com/rssfeed/news/1001/5591?ch=fb_share' : 'https://www.cnbc.com/id/100003114/device/rss/rss.html', person_id: null, is_official: false, fetch_method: 'RSS' };
  const out = await fetchSourceCandidates(src as never, new Date(Date.now() - 7 * 24 * 3600_000).toISOString());
  console.log(slug, out.candidates.length, out.candidates.slice(0, 8).map((c) => c.title));
}
