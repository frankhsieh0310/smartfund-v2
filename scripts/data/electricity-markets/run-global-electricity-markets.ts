import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'

type Market = Record<string, unknown> & { id: string; market: string; timezone: string; adapter: string; canary?: boolean }
type Registry = { asset: string; policy: { boundedBatchHours: number }; markets: Market[] }

const root = process.cwd()
const runtime = join(root, 'runtime', 'electricity-markets')
const archiveRoot = join(runtime, 'archive')
const registryPath = join(root, 'scripts', 'data', 'electricity-markets', 'registry.json')
const logPath = join(runtime, 'electricity-markets.log')
const checkpointPath = join(runtime, 'checkpoint.json')
const once = process.argv.includes('--canary')
const selectedMarket = process.argv.find(argument => argument.startsWith('--market='))?.split('=')[1] ?? 'gb-elexon'
const prisma = new PrismaClient()

const iso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await rename(temporary, path)
}
async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
}
async function log(message: string) { await writeFile(logPath, `${iso()} ${message}\n`, { flag: 'a' }) }
async function state(stage: string, scope: string, cycle: number) {
  const previous = await loadJson<Record<string, unknown>>(checkpointPath, {})
  const value = { ...previous, asset: 'GLOBAL_ELECTRICITY_MARKETS', pid: process.pid, processAlive: true, stage, scope, cycle, updatedAt: iso(), autoContinuing: !once }
  await atomicJson(checkpointPath, value)
  await atomicJson(join(runtime, 'heartbeat.json'), value)
}
function compactUtc(offsetHours = 0) {
  const date = new Date(Date.now() + offsetHours * 3_600_000)
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').slice(0, 13) + '00'
}
async function requestFor(market: Market) {
  const canonicalRows = await prisma.$queryRaw<Array<{ observed_at: Date }>>`
    SELECT observed_at FROM electricity_observations
    WHERE market = ${String(market.market)} AND metric_type = 'price'
    ORDER BY observed_at DESC LIMIT 1
  `
  const coverageRows = await prisma.$queryRaw<Array<{ delivery_days: bigint }>>`
    SELECT COUNT(DISTINCT (observed_at AT TIME ZONE ${market.timezone})::date) AS delivery_days
    FROM electricity_observations WHERE market = ${String(market.market)} AND LOWER(metric_type) = 'price'
  `
  const deliveryDays = Number(coverageRows[0]?.delivery_days ?? 0)
  const recoveryHours = deliveryDays < 7 ? 7 * 24 : 24
  const lowerBound = Date.now() - recoveryHours * 3_600_000
  const resumeAt = canonicalRows[0]?.observed_at.getTime() ?? Date.now() - 3_600_000
  const from = new Date(deliveryDays < 7 ? lowerBound : Math.max(lowerBound, resumeAt)).toISOString()
  const to = new Date().toISOString()
  if (market.adapter === 'caiso-oasis') {
    const start = compactUtc(-24); const end = compactUtc()
    return { url: `https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&startdatetime=${start}-0000&enddatetime=${end}-0000&version=12&market_run_id=DAM&node=TH_NP15_GEN-APND`, extension: 'zip' }
  }
  if (market.adapter === 'elexon-bmrs') return { url: `https://data.elexon.co.uk/bmrs/api/v1/balancing/pricing/market-index?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=json`, extension: 'json' }
  if (market.adapter === 'aemo-nemweb') return { url: 'https://nemweb.com.au/Reports/Current/TradingIS_Reports/', extension: 'html' }
  throw new Error(`No active adapter: ${market.adapter}`)
}
async function appendQueue(name: string, entry: unknown) {
  const path = join(runtime, name)
  const current = await loadJson<unknown[]>(path, [])
  current.push(entry)
  await atomicJson(path, current.slice(-500))
}
async function fetchMarket(market: Market, stage: string, cycle: number) {
  const request = await requestFor(market)
  const response = await fetch(request.url, { headers: { accept: '*/*', 'user-agent': 'SmartFund-Electricity-Markets/1.0' }, signal: AbortSignal.timeout(45_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > 25_000_000) throw new Error(`Invalid bounded response size ${bytes.length}`)
  const deliveryDate = new Intl.DateTimeFormat('en-CA', { timeZone: market.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const dir = join(archiveRoot, market.id, deliveryDate)
  await mkdir(dir, { recursive: true })
  const stamp = iso().replaceAll(':', '-').replaceAll('.', '-')
  const archive = join(dir, `${stage}-${stamp}.${request.extension}`)
  await writeFile(archive, bytes)
  const record = { ...market, node: market.id === 'caiso' ? 'TH_NP15_GEN-APND' : null, deliveryDate, deliveryHour: null, fetchedAt: iso(), bytes: bytes.length, contentType: response.headers.get('content-type'), sourceUrl: request.url, archive }
  await atomicJson(join(dir, `${stage}-${stamp}.metadata.json`), record)
  if (market.adapter !== 'elexon-bmrs') throw new Error(`Canonical parser is not enabled for ${market.adapter}`)
  await prisma.$executeRaw`
    INSERT INTO electricity_markets
      (canonical_market_id, official_name, short_name, operator, operator_type, country, jurisdiction, region, currency, timezone, market_type, official_url, status, verification_status, created_at, updated_at)
    VALUES
      (${market.id}, ${String(market.officialName)}, ${String(market.market)}, ${String(market.operator)}, ${String(market.operatorType)}, ${String(market.country)}, ${String(market.jurisdiction)}, ${String(market.region)}, ${String(market.currency)}, ${market.timezone}, ${String(market.marketType)}, ${String(market.officialUrl)}, 'ACTIVE', ${String(market.verificationStatus)}, NOW(), NOW())
    ON CONFLICT (canonical_market_id) DO UPDATE SET
      official_name=EXCLUDED.official_name, operator=EXCLUDED.operator, operator_type=EXCLUDED.operator_type,
      country=EXCLUDED.country, jurisdiction=EXCLUDED.jurisdiction, region=EXCLUDED.region,
      currency=EXCLUDED.currency, timezone=EXCLUDED.timezone, market_type=EXCLUDED.market_type,
      official_url=EXCLUDED.official_url, status=EXCLUDED.status, verification_status=EXCLUDED.verification_status, updated_at=NOW()
  `
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as { data?: Array<{ startTime?: string; dataProvider?: string; price?: number }> }
  const observations = (payload.data ?? []).flatMap(item => {
    if (!item.startTime || !item.dataProvider || !Number.isFinite(item.price)) return []
    const observedAt = new Date(item.startTime)
    const localParts = new Intl.DateTimeFormat('en-CA', { timeZone: market.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(observedAt)
    const part = (type: string) => localParts.find(value => value.type === type)?.value ?? ''
    return [{
      market: String(market.market), region: typeof market.region === 'string' ? market.region : null, node: item.dataProvider,
      observedAt, deliveryEnd: new Date(observedAt.getTime() + 30 * 60_000), deliveryLocalDate: `${part('year')}-${part('month')}-${part('day')}`, deliveryLocalStart: `${part('hour')}:${part('minute')}`,
      timezone: market.timezone, metricType: 'price', value: item.price!,
      unit: String(market.unit), source: 'Elexon BMRS',
      sourceKey: createHash('sha256').update(`${market.id}|${item.dataProvider}|${item.startTime}|price`).digest('hex'),
    }]
  }).filter(item => !Number.isNaN(item.observedAt.getTime()))
  if (observations.length === 0) throw new Error('No valid Elexon observations parsed')
  for (const observation of observations) {
    const locationId = `${market.id}:${observation.node}`
    await prisma.$executeRaw`
      INSERT INTO electricity_locations
        (canonical_location_id, canonical_market_id, official_code, official_name, location_type, country, region, status, source, created_at, updated_at)
      VALUES (${locationId}, ${market.id}, ${observation.node}, ${observation.node}, 'HUB', ${String(market.country)}, ${observation.region}, 'ACTIVE', 'Elexon BMRS', NOW(), NOW())
      ON CONFLICT (canonical_location_id) DO UPDATE SET status='ACTIVE', updated_at=NOW()
    `
    await prisma.$executeRaw`
      INSERT INTO electricity_observations
        (id, market, region, node, observed_at, timezone, metric_type, value, unit, source, source_key, created_at,
         canonical_market_id, canonical_location_id, product_type, price_type, delivery_end, delivery_local_date,
         delivery_local_start, interval_minutes, currency, source_url, retrieved_at, verification_status, freshness_status, settlement_status)
      VALUES
        (${randomUUID()}::uuid, ${observation.market}, ${observation.region}, ${observation.node}, ${observation.observedAt}, ${observation.timezone}, ${observation.metricType}, ${observation.value}, ${observation.unit}, ${observation.source}, ${observation.sourceKey}, NOW(),
         ${market.id}, ${locationId}, 'BALANCING', 'SYSTEM_PRICE', ${observation.deliveryEnd}, ${observation.deliveryLocalDate},
         ${observation.deliveryLocalStart}, 30, ${String(market.currency)}, ${request.url}, NOW(), 'VERIFIED_OFFICIAL', 'CURRENT', 'UNKNOWN')
      ON CONFLICT (source_key) DO UPDATE SET
        market = EXCLUDED.market, region = EXCLUDED.region, node = EXCLUDED.node,
        observed_at = EXCLUDED.observed_at, timezone = EXCLUDED.timezone,
        metric_type = EXCLUDED.metric_type, value = EXCLUDED.value,
        unit = EXCLUDED.unit, source = EXCLUDED.source, canonical_market_id=EXCLUDED.canonical_market_id,
        canonical_location_id=EXCLUDED.canonical_location_id, product_type=EXCLUDED.product_type,
        price_type=EXCLUDED.price_type, delivery_end=EXCLUDED.delivery_end,
        delivery_local_date=EXCLUDED.delivery_local_date, delivery_local_start=EXCLUDED.delivery_local_start,
        interval_minutes=EXCLUDED.interval_minutes, currency=EXCLUDED.currency, source_url=EXCLUDED.source_url,
        retrieved_at=EXCLUDED.retrieved_at, verification_status=EXCLUDED.verification_status,
        freshness_status=EXCLUDED.freshness_status, settlement_status=EXCLUDED.settlement_status
    `
  }
  const latest = observations.reduce((left, right) => left.observedAt > right.observedAt ? left : right)
  const readBackRows = await prisma.$queryRaw<Array<{ observed_at: Date; value: unknown }>>`
    SELECT observed_at, value FROM electricity_observations WHERE source_key = ${latest.sourceKey} LIMIT 1
  `
  const readBack = readBackRows[0]
  if (!readBack || readBack.observed_at.getTime() !== latest.observedAt.getTime() || Number(readBack.value) !== latest.value) {
    throw new Error('Canonical read-back mismatch')
  }
  const checkpoint = await loadJson<Record<string, any>>(checkpointPath, {})
  checkpoint.markets = { ...(checkpoint.markets ?? {}), [market.id]: { lastCanonicalTimestamp: latest.observedAt.toISOString(), sourceLatestTimestamp: latest.observedAt.toISOString(), lastSuccessAt: iso() } }
  await atomicJson(checkpointPath, checkpoint)
  return { ...record, fetch: 'PASS', parse: 'PASS', canonicalMapping: 'PASS', canonicalWrite: 'PASS', readBack: 'PASS', metric: 'price', written: observations.length, latestTimestamp: latest.observedAt.toISOString(), latestValue: latest.value, source: 'Elexon BMRS' }
}

async function refreshCoverage(registry: Registry) {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT canonical_market_id AS "marketId", canonical_location_id AS "locationId", product_type AS product,
      price_type AS "priceType", interval_minutes AS "intervalMinutes", COUNT(*)::text AS "canonicalRows",
      MIN(observed_at) AS "firstDate", MAX(observed_at) AS "latestDate",
      COUNT(DISTINCT delivery_local_date)::text AS "deliveryDays",
      MIN(verification_status) AS "verificationStatus", MIN(freshness_status) AS "freshnessStatus"
    FROM electricity_observations WHERE canonical_market_id IS NOT NULL
    GROUP BY 1,2,3,4,5 ORDER BY 1,2
  `
  await atomicJson(join(runtime, 'series-coverage-matrix.json'), { generatedAt: iso(), rows })
  await atomicJson(join(runtime, 'market-coverage-matrix.json'), { generatedAt: iso(), rows: registry.markets.map(market => ({ marketId: market.id, operator: market.operator ?? null, country: market.country ?? null, timezone: market.timezone, coverageStatus: market.coverageStatus ?? 'SOURCE_PENDING', currentCoverage: rows.some(row => row.marketId === market.id), priceCoverage: rows.some(row => row.marketId === market.id), loadCoverage: false, generationCoverage: false, fuelMixCoverage: false, interconnectorCoverage: false })) })
}
async function runStage(markets: Market[], stage: string, cycle: number) {
  await state(stage, markets.map(m => m.id).join(','), cycle)
  const results: unknown[] = []
  for (const market of markets) {
    try {
      const result = await fetchMarket(market, stage, cycle)
      results.push({ status: 'ok', ...result })
      await log(`OK stage=${stage} market=${market.id}`)
    } catch (error) {
      const failure = { market: market.id, stage, cycle, attempt: 1, nextRetryAt: new Date(Date.now() + 300_000).toISOString(), error: String(error), failedAt: iso() }
      results.push({ status: 'failed', ...failure })
      await appendQueue('failure-queue.json', failure)
      await appendQueue('dead-letter.json', failure)
      await log(`FAILED stage=${stage} market=${market.id} error=${String(error)}`)
    }
  }
  return results
}
async function main() {
  await mkdir(archiveRoot, { recursive: true })
  const registry = await loadJson<Registry>(registryPath, { asset: 'GLOBAL_ELECTRICITY_MARKETS', policy: { boundedBatchHours: 24 }, markets: [] })
  const markets = registry.markets.filter(m => m.canary && m.id === selectedMarket)
  if (markets.length !== 1) throw new Error(`Configured market not found: ${selectedMarket}`)
  let cycle = (await loadJson<{ cycle?: number }>(checkpointPath, {})).cycle ?? 0
  do {
    cycle += 1
    const stage = once || cycle === 1 ? 'canary' : 'incremental'
    const results = await runStage(markets, stage, cycle)
    const manifest = { asset: registry.asset, stage, cycle, completedAt: iso(), boundedBatchHours: registry.policy.boundedBatchHours, successful: results.filter((r: any) => r.status === 'ok').length, failed: results.filter((r: any) => r.status === 'failed').length, results, autoContinuing: !once }
    if (stage === 'canary') await atomicJson(join(runtime, 'canary-result.json'), manifest)
    await atomicJson(join(runtime, 'completion-manifest.json'), manifest)
    await refreshCoverage(registry)
    await state('sleep', 'next-incremental-cycle', cycle)
    if (!once) await sleep(60 * 60 * 1000)
  } while (!once)
}

process.on('SIGTERM', () => { void log('SIGTERM received'); process.exit(0) })
main().catch(async error => { await log(`FATAL ${String(error)}`); process.exitCode = 1 }).finally(async () => { await prisma.$disconnect() })
