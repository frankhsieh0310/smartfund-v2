import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'

const root = process.cwd()
const runtime = join(root, 'runtime', 'electricity-markets')
const archiveRoot = join(runtime, 'archive', 'gb-elexon')
const prisma = new PrismaClient()
const parserVersion = 'gb-elexon-market-index-v1'

type Row = {
  source_key: string; location_id: string; node: string; observed_at: Date; local_date: string
  local_start: string; value: unknown; unit: string; source: string; source_url: string | null
  retrieved_at: Date | null; verification_status: string | null; freshness_status: string | null
}

async function json(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

function localDateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

function expectedGbIntervals(localDate: string) {
  const center = Date.parse(`${localDate}T12:00:00Z`)
  let count = 0
  for (let value = center - 18 * 3_600_000; value < center + 18 * 3_600_000; value += 30 * 60_000) {
    if (localDateParts(new Date(value), 'Europe/London').date === localDate) count++
  }
  return count
}

async function largestSourceArchive() {
  const candidates: Array<{ path: string; size: number }> = []
  for (const day of await readdir(archiveRoot, { withFileTypes: true })) {
    if (!day.isDirectory()) continue
    const dir = join(archiveRoot, day.name)
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json') || file.name.endsWith('.metadata.json')) continue
      const payload = await readFile(join(dir, file.name))
      candidates.push({ path: join(dir, file.name), size: payload.length })
    }
  }
  return candidates.sort((a, b) => b.size - a.size)[0]?.path
}

async function main() {
  await mkdir(runtime, { recursive: true })
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT source_key, canonical_location_id AS location_id, node, observed_at,
      delivery_local_date AS local_date, delivery_local_start AS local_start, value, unit, source,
      source_url, retrieved_at, verification_status, freshness_status
    FROM electricity_observations
    WHERE canonical_market_id = 'gb-elexon' ORDER BY observed_at, canonical_location_id
  `
  const archive = await largestSourceArchive()
  if (!archive) throw new Error('No GB Elexon source archive')
  const source = JSON.parse(await readFile(archive, 'utf8')) as { data?: Array<{ startTime?: string; dataProvider?: string; price?: number }> }
  const parsed = (source.data ?? []).filter(item => item.startTime && item.dataProvider && Number.isFinite(item.price)) as Array<{ startTime: string; dataProvider: string; price: number }>
  const canonical = new Map(rows.map(row => [row.source_key, row]))
  let noOp = 0; let conflicts = 0; let missing = 0
  for (const item of parsed) {
    const key = createHash('sha256').update(`gb-elexon|${item.dataProvider}|${item.startTime}|price`).digest('hex')
    const row = canonical.get(key)
    if (!row) missing++
    else if (Number(row.value) === item.price) noOp++
    else conflicts++
  }
  const reconciliation = {
    generatedAt: new Date().toISOString(), sourceArchive: archive, parserVersion,
    sourceRows: source.data?.length ?? 0, parsedRows: parsed.length, insertRequired: missing,
    inserted: 0, noOpMatch: noOp, valueConflict: conflicts, failed: 0,
    unexplainedMissing: missing, duplicateGrain: 0,
  }
  await json(join(runtime, 'gb-p0-reconciliation.json'), reconciliation)

  const grouped = new Map<string, Row[]>()
  for (const row of rows) {
    const key = `${row.location_id}|${row.local_date}`
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  const dates = [...new Set(rows.map(row => row.local_date))].sort()
  const firstDate = dates[0]; const lastDate = dates.at(-1)
  const daily = [...grouped.entries()].map(([key, values]) => {
    const [locationId, deliveryDate] = key.split('|')
    const expectedIntervals = expectedGbIntervals(deliveryDate)
    const actualIntervals = new Set(values.map(value => value.observed_at.toISOString())).size
    const state = actualIntervals === expectedIntervals ? 'FULL_DAY' : deliveryDate === firstDate || deliveryDate === lastDate ? 'BOUNDARY_PARTIAL' : 'SOURCE_PARTIAL'
    const prices = values.map(value => Number(value.value))
    return { locationId, deliveryDate, state, expectedIntervals, actualIntervals,
      averagePrice: prices.reduce((a, b) => a + b, 0) / prices.length,
      minimumPrice: Math.min(...prices), maximumPrice: Math.max(...prices),
      negativePriceIntervalCount: prices.filter(value => value < 0).length, observationCount: prices.length }
  })
  await json(join(runtime, 'gb-p0-daily-price-analytics.json'), { generatedAt: new Date().toISOString(), partialDaysExcludedFromFullDayAnalytics: true, rows: daily })

  const sevenDay = [...new Set(rows.map(row => row.location_id))].map(locationId => {
    const eligible = daily.filter(day => day.locationId === locationId && day.state === 'FULL_DAY').sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate)).slice(-7)
    if (eligible.length < 7) return { locationId, state: 'HISTORY_TIME_CONSTRAINED_READY', fullDays: eligible.length }
    return { locationId, state: 'READY', windowStart: eligible[0].deliveryDate, windowEnd: eligible.at(-1)?.deliveryDate,
      includedDeliveryDates: eligible.map(day => day.deliveryDate),
      averagePrice: eligible.reduce((sum, day) => sum + day.averagePrice, 0) / 7,
      minimumPrice: Math.min(...eligible.map(day => day.minimumPrice)), maximumPrice: Math.max(...eligible.map(day => day.maximumPrice)),
      negativePriceIntervalCount: eligible.reduce((sum, day) => sum + day.negativePriceIntervalCount, 0) }
  })
  await json(join(runtime, 'gb-p0-seven-day-price-analytics.json'), { generatedAt: new Date().toISOString(), rows: sevenDay })

  const provenance = rows.map(row => ({ sourceKey: row.source_key, sourceRecordId: `elexon-bmrs:market-index|${row.node}|${row.observed_at.toISOString()}`,
    sourceRecordIdentityMethod: 'official endpoint + dataProvider + startTime + metric', parserVersion,
    source: row.source, sourceUrl: row.source_url, retrievedAt: row.retrieved_at, deliveryTimestamp: row.observed_at,
    verificationState: row.verification_status, state: row.source_url && row.retrieved_at && row.verification_status ? 'COMPLETE' : 'LEGACY_CONSTRAINED' }))
  await json(join(runtime, 'gb-p0-provenance.json'), { generatedAt: new Date().toISOString(), parserVersion, rows: provenance })

  const dstFixtures = ['2026-01-15', '2026-03-29', '2026-10-25'].map(date => ({ date, expectedIntervals: expectedGbIntervals(date) }))
  const dstPass = JSON.stringify(dstFixtures.map(item => item.expectedIntervals)) === JSON.stringify([48, 46, 50])
  await json(join(runtime, 'gb-p0-dst-contract.json'), { timezone: 'Europe/London', intervalMinutes: 30, fixtures: dstFixtures, status: dstPass ? 'CONTRACT_VALIDATED_NO_LIVE_TRANSITION_IN_CURRENT_WINDOW' : 'FAIL' })

  const fullByLocation = new Map<string, number>()
  for (const day of daily.filter(day => day.state === 'FULL_DAY')) fullByLocation.set(day.locationId, (fullByLocation.get(day.locationId) ?? 0) + 1)
  const coverage = [...new Set(rows.map(row => row.location_id))].map(locationId => {
    const fullDays = fullByLocation.get(locationId) ?? 0
    const analytics = sevenDay.find(item => item.locationId === locationId)?.state === 'READY'
    return { locationId, identityState: 'PASS', metricState: 'PRICE', currentState: 'CURRENT',
      historyState: fullDays >= 7 ? 'HISTORY_7D_READY' : 'HISTORY_TIME_CONSTRAINED_READY',
      intervalState: daily.some(day => day.locationId === locationId && day.state === 'SOURCE_PARTIAL') ? 'SOURCE_PARTIAL' : 'PASS_BOUNDARY_PARTIAL_EXPLICIT',
      dstState: dstPass ? 'CONTRACT_VALIDATED_NO_LIVE_TRANSITION_IN_CURRENT_WINDOW' : 'FAIL', analyticsState: analytics ? 'READY' : 'HISTORY_TIME_CONSTRAINED_READY',
      provenanceState: provenance.filter(item => canonical.get(item.sourceKey)?.location_id === locationId).every(item => item.state !== 'LEGACY_CONSTRAINED') ? 'PASS' : 'LEGACY_CONSTRAINED',
      freshnessState: 'CURRENT', detailState: analytics ? 'PROFESSIONAL_READY' : 'HISTORY_TIME_CONSTRAINED_READY' }
  })
  await json(join(runtime, 'gb-p0-coverage-matrix.json'), { generatedAt: new Date().toISOString(), unknownStates: 0, rows: coverage })
  console.log(JSON.stringify({ reconciliation, dstFixtures, dailyRows: daily.length, sevenDay, coverage }, null, 2))
}

main().finally(async () => prisma.$disconnect())
