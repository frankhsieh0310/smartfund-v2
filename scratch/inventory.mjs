import { readFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

const raw = readFileSync('scratch/git_status.nul', 'latin1');
const entries = raw.split('\0').filter(Boolean).map((line) => ({ code: line.slice(0, 2), file: line.slice(3) }));

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.git', '.turbo', '.vercel']);
// Top-level paths that are runtime scratch/checkpoint/log output, not production source — excluded
// per the "don't scan large data output / temp files" instruction (runtime/ alone holds ~180K
// checkpoint/log/raw files from local canary + ingestion script runs, e.g. runtime/insider-ownership/).
const EXCLUDE_TOP_LEVEL = new Set(['runtime', 'runtime-status', 'runtime-status - 複製', 'artifacts_scratch', 'tmp', '.tmp', 'node_modules', '.next', '.vercel', '.swc', '.scratch', 'scratch', 'review-output']);
function countFiles(rel) {
  const abs = path.join(process.cwd(), rel);
  let st;
  try { st = statSync(abs); } catch { return 0; }
  if (!st.isDirectory()) return 1;
  let count = 0;
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (it.isDirectory()) { if (!EXCLUDE_DIRS.has(it.name)) stack.push(path.join(dir, it.name)); }
      else count++;
    }
  }
  return count;
}

// Category rules — order matters, first match wins.
const RULES = [
  [/^app\/movement-radar\//, 'MOVEMENT_RADAR'],
  [/^components\/movement-radar\//, 'MOVEMENT_RADAR'],
  [/^app\/api\/consensus\//, 'CONSENSUS'],
  [/^app\/api\/cron\/consensus/, 'CONSENSUS'],
  [/^app\/api\/mobile\/congress-trades/, 'CONGRESS'],
  [/^app\/api\/mobile\/insider-trades/, 'INSIDER'],
  [/^app\/api\/mobile\/institutional-holdings/, 'INSTITUTIONAL'],
  [/^config\/consensus\//, 'CONSENSUS'],
  [/^lib\/consensus\//, 'CONSENSUS'],
  [/^app\/workflows\//, 'WORKFLOW_CORE'],
  [/^app\/api\/workflows\//, 'WORKFLOW_CORE'],
  [/^lib\/cloud-ingestion\//, 'WORKFLOW_CORE'],
  [/^lib\/cron\//, 'WORKFLOW_CORE'],
  [/config\/.*insider/i, 'INSIDER'],
  [/config\/.*institutional/i, 'INSTITUTIONAL'],
  [/^scripts\/data\/insider/, 'INSIDER'],
  [/^scripts\/data\/institutional/, 'INSTITUTIONAL'],
  [/config\/.*\bfx\b/i, 'FX'],
  [/config\/.*currency/i, 'FX'],
  [/^app\/api\/cron\/yahoo-fx/, 'FX'],
  [/config\/.*\bindex\b/i, 'INDEX'],
  [/config\/global-index/i, 'INDEX'],
  [/config\/.*\betf\b/i, 'ETF'],
  [/^app\/api\/cron\/.*etf/i, 'ETF'],
  [/^scripts\/data\/.*etf/i, 'ETF'],
  [/config\/.*fund\b/i, 'FUND'],
  [/config\/.*moneydj/i, 'FUND'],
  [/^app\/api\/cron\/.*fund/i, 'FUND'],
  [/^scripts\/data\/.*fund/i, 'FUND'],
  [/config\/.*analyst-estimates/i, 'FUNDAMENTALS'],
  [/config\/.*earnings/i, 'FUNDAMENTALS'],
  [/config\/.*fundamental/i, 'FUNDAMENTALS'],
  [/^lib\/fundamentals\//, 'FUNDAMENTALS'],
  [/^lib\/cloud-ingestion/, 'CLOUD_INGESTION'],
  [/^app\/api\/cron\//, 'CLOUD_INGESTION'],
  [/^app\/(page\.tsx|layout\.tsx|globals\.css)$/, 'WEB_UI'],
  [/^app\/(search|stocks|etf|fund|funds|indices|industry-chain|portfolio|screener|rankings|auth|admin|compare)\//, 'WEB_UI'],
  [/^components\/(home|asset|auth)\//, 'WEB_UI'],
  [/^app\/api\/(search|stocks|watchlists|portfolios|me|push|home-rankings|home-market-overview|government-yields|industry-chain|funds|compare|alerts)\//, 'SHARED_API'],
  [/^app\/api\/mobile\//, 'SHARED_API'],
  [/^lib\/(prisma|web|auth|watchlist|alerts|yahoo)\//, 'SHARED_DATA_MODEL'],
  [/^lib\/services\//, 'SHARED_DATA_MODEL'],
  [/^lib\/data-platform\//, 'SHARED_DATA_MODEL'],
  [/^prisma\//, 'SHARED_DATA_MODEL'],
  [/^db\//, 'SHARED_DATA_MODEL'],
  [/^\.github\//, 'DEPLOYMENT_CONFIG'],
  [/^vercel\.json$/, 'DEPLOYMENT_CONFIG'],
  [/^\.vercelignore$/, 'DEPLOYMENT_CONFIG'],
  [/^package(-lock)?\.json$/, 'DEPLOYMENT_CONFIG'],
  [/^tsconfig.*\.json$/, 'DEPLOYMENT_CONFIG'],
  [/^next\.config.*$/, 'DEPLOYMENT_CONFIG'],
  [/^scripts\/(data|.*verify|.*test|.*canary)/i, 'TEST_VERIFY'],
  [/^scripts\//, 'OTHER'],
  [/^config\//, 'OTHER'],
  [/^docs\//, 'OTHER'],
  [/\.(docx|pdf)$/, 'OTHER'],
  [/^app\//, 'WEB_UI'],
  [/^components\//, 'WEB_UI'],
  [/^lib\//, 'SHARED_DATA_MODEL'],
];

function categorize(file) {
  for (const [re, cat] of RULES) if (re.test(file)) return cat;
  return 'UNKNOWN';
}

const buckets = {};
const excludedScratch = [];
for (const e of entries) {
  const top = e.file.split('/')[0];
  if (EXCLUDE_TOP_LEVEL.has(top)) { excludedScratch.push(e.file); continue; }
  const cat = categorize(e.file);
  const n = countFiles(e.file);
  if (!buckets[cat]) buckets[cat] = { count: 0, samples: [], gitCodes: new Set() };
  buckets[cat].count += n;
  buckets[cat].gitCodes.add(e.code.trim() || 'UNTRACKED');
  if (buckets[cat].samples.length < 12) buckets[cat].samples.push(`${e.code.trim()} ${e.file}`);
}

const out = Object.entries(buckets).sort((a, b) => b[1].count - a[1].count).map(([cat, v]) => ({ cat, count: v.count, codes: [...v.gitCodes], samples: v.samples }));
console.log(JSON.stringify(out, null, 2));
console.log('TOTAL_ENTRIES_SCANNED:', entries.length);
console.log('TOTAL_FILES_COUNTED:', out.reduce((s, x) => s + x.count, 0));
console.log('EXCLUDED_SCRATCH_TOPLEVEL_ENTRIES:', excludedScratch.length, excludedScratch);
