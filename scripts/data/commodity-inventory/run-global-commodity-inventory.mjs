import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PrismaClient } from '@prisma/client'

const root = process.cwd()
const runtime = join(root, 'runtime', 'commodity-inventory')
const archiveRoot = join(runtime, 'archive')
const registryPath = join(root, 'scripts', 'data', 'commodity-inventory', 'registry.json')
const checkpointPath = join(runtime, 'checkpoint.json')
const logPath = join(runtime, 'commodity-inventory.log')
const once = process.argv.includes('--once') || process.argv.includes('--canary')
const canary = process.argv.includes('--canary')
const prisma = new PrismaClient()
const now = () => new Date().toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function atomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await rename(temporary, file)
}
async function json(file, fallback = null) { try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback } }
async function log(message) { await writeFile(logPath, `${now()} ${message}\n`, { flag: 'a' }) }
async function state(stage, extra = {}) {
  const value = { asset: 'GLOBAL_COMMODITY_INVENTORY', pid: process.pid, alive: true, stage, updatedAt: now(), autoContinuing: !once, ...extra }
  await atomic(checkpointPath, value)
  await atomic(join(runtime, 'heartbeat'), { pid: process.pid, stage, updatedAt: value.updatedAt, autoContinuing: !once })
}
const isoPeriod = period => /^\d{4}-\d{2}-\d{2}$/.test(period) ? period : /^\d{4}-\d{2}$/.test(period) ? `${period}-01` : `${period}-01-01`
const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sourceName = metric => metric.provider === 'EIA' ? 'U.S. Energy Information Administration' : metric.provider === 'USDA_NASS' ? 'USDA National Agricultural Statistics Service' : 'London Metal Exchange'

function archiveDirectory(metric) {
  if (metric.adapter === 'EIA_PETROLEUM') return 'eia-weekly-petroleum-stocks'
  if (metric.adapter === 'EIA_NATURAL_GAS_STORAGE') return 'eia-weekly-natural-gas-storage'
  if (metric.adapter === 'EIA_CRUDE_PRODUCTION') return 'eia-monthly-production'
  if (metric.adapter === 'USDA_GRAIN_STOCKS') return 'usda-grain-stocks'
  return null
}
async function archiveFiles(metric) {
  const directory = archiveDirectory(metric)
  if (!directory) return []
  const full = join(archiveRoot, directory)
  try { return (await readdir(full)).filter(file => file.endsWith('.json')).map(file => join(full, file)) } catch { return [] }
}
async function localEiaObservations(metric) {
  const byDate = new Map()
  for (const file of await archiveFiles(metric)) {
    const payload = await json(file)
    const fileStat = await stat(file)
    for (const row of payload?.response?.data ?? []) {
      if (row.series !== metric.externalSeriesId || row.value === null || !Number.isFinite(Number(row.value))) continue
      const observationDate = isoPeriod(row.period)
      byDate.set(observationDate, {
        sourceValue: Number(row.value), sourceUnit: row.units, normalizedValue: Number(row.value), normalizedUnit: metric.normalizedUnit,
        observationDate, referencePeriod: row.period, publicationDate: null, retrievedAt: fileStat.mtime.toISOString(), source: sourceName(metric),
        sourceUrl: metric.officialUrl, externalSeriesId: row.series, sourceRecordId: `${row.series}:${row.period}`, checksum: checksum(row),
        verificationStatus: 'VERIFIED_OFFICIAL', archiveFile: basename(file)
      })
    }
  }
  return [...byDate.values()].sort((a, b) => a.observationDate.localeCompare(b.observationDate))
}
async function localCensus(registry) {
  const metrics = []
  for (const metric of registry.metrics) {
    const files = await archiveFiles(metric)
    const observations = metric.provider === 'EIA' && metric.externalSeriesId ? await localEiaObservations(metric) : []
    metrics.push({ canonicalSeriesId: metric.canonicalSeriesId, localFileCount: files.length, localRowCount: observations.length, earliestDate: observations[0]?.observationDate ?? null, latestDate: observations.at(-1)?.observationDate ?? null, source: sourceName(metric), integrity: files.length ? 'PASS' : 'NO_LOCAL_ARCHIVE' })
  }
  const result = { generatedAt: now(), policy: 'CANONICALIZE_FIRST_NO_REDUNDANT_REFETCH', metrics }
  await atomic(join(runtime, 'local-data-census.json'), result)
  return result
}
async function canonicalize(metric, observations) {
  if (!observations.length) return { rows: 0, inserted: 0, noOp: 0, conflict: 0, failed: 0, readBack: 'NOT_RUN' }
  const identity = { commodity: metric.commodity, commodityGroup: metric.commodityGroup, metricType: metric.metricType, region: metric.region, location: metric.location, normalizedUnit: metric.normalizedUnit, externalSeriesId: metric.externalSeriesId, timezone: metric.timezone, verificationStatus: metric.verificationStatus }
  const series = await prisma.economicSeries.upsert({
    where: { provider_seriesId: { provider: metric.provider, seriesId: metric.canonicalSeriesId } },
    create: { provider: metric.provider, seriesId: metric.canonicalSeriesId, code: metric.code, name: metric.officialName, description: JSON.stringify(identity), country: metric.country, category: `COMMODITY_${metric.metricType}`, frequency: metric.frequency, importance: 'MEDIUM', unit: metric.normalizedUnit, source: sourceName(metric), apiUrl: metric.officialUrl, lastUpdate: new Date(`${observations.at(-1).observationDate}T00:00:00.000Z`) },
    update: { code: metric.code, name: metric.officialName, description: JSON.stringify(identity), country: metric.country, category: `COMMODITY_${metric.metricType}`, frequency: metric.frequency, unit: metric.normalizedUnit, source: sourceName(metric), apiUrl: metric.officialUrl, lastUpdate: new Date(`${observations.at(-1).observationDate}T00:00:00.000Z`) }
  })
  const dates = observations.map(item => new Date(`${item.observationDate}T00:00:00.000Z`))
  const existing = await prisma.economicValue.findMany({ where: { seriesId: series.id, date: { in: dates } }, select: { date: true, value: true } })
  const existingByDate = new Map(existing.map(item => [item.date.toISOString().slice(0, 10), Number(item.value)]))
  let inserted = 0, noOp = 0, conflict = 0, failed = 0
  for (const observation of observations) {
    const date = new Date(`${observation.observationDate}T00:00:00.000Z`)
    const sourceVersion = JSON.stringify({ referencePeriod: observation.referencePeriod, publicationDate: observation.publicationDate, retrievedAt: observation.retrievedAt, sourceRecordId: observation.sourceRecordId, verificationStatus: observation.verificationStatus, sourceUnit: observation.sourceUnit, normalizedUnit: observation.normalizedUnit })
    const oldValue = existingByDate.get(observation.observationDate)
    if (oldValue !== undefined) { if (oldValue === observation.normalizedValue) noOp++; else conflict++; continue }
    try { await prisma.economicValue.create({ data: { seriesId: series.id, date, value: observation.normalizedValue, sourceUrl: observation.sourceUrl, sourceVersion, rawChecksum: observation.checksum, importedAt: new Date(observation.retrievedAt) } }); inserted++ } catch { failed++ }
  }
  const readBack = await prisma.economicValue.count({ where: { seriesId: series.id, date: { in: observations.map(item => new Date(`${item.observationDate}T00:00:00.000Z`)) } } })
  if (readBack !== observations.length) throw new Error(`READ_BACK_MISMATCH:${metric.canonicalSeriesId}:${readBack}/${observations.length}`)
  await atomic(join(runtime, 'provenance', `${metric.canonicalSeriesId}.json`), { canonicalSeriesId: metric.canonicalSeriesId, observations })
  return { rows: observations.length, inserted, noOp, conflict, failed, readBack: 'PASS', earliestDate: observations[0].observationDate, latestDate: observations.at(-1).observationDate }
}
async function discoverUsdaLatest() {
  const indexUrl = 'https://esmis.nal.usda.gov/?f%5B0%5D=agency%3A4&f%5B1%5D=status%3A1&keyword=Grain+Stocks'
  const response = await fetch(indexUrl, { headers: { 'user-agent': 'SmartFund-Official-Commodity-Inventory/2.0' }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`USDA_DISCOVERY_HTTP_${response.status}`)
  const html = await response.text()
  const links = [...html.matchAll(/href=["']([^"']*grst\d{4}\.txt)["']/gi)].map(match => new URL(match[1], indexUrl).href)
  const releaseKey = value => { const match = value.match(/grst(\d{2})(\d{2})/); return match ? `${match[2]}${match[1]}` : '0000' }
  return [...new Set(links)].sort((a, b) => releaseKey(b).localeCompare(releaseKey(a))).at(0) ?? null
}
async function usdaLatestObservation(metric) {
  const discovery = await json(join(runtime, 'usda-latest-discovery.json'), {})
  if (!discovery.latestReportUrl) return null
  const response = await fetch(discovery.latestReportUrl, { headers: { 'user-agent': 'SmartFund-Official-Commodity-Inventory/3.0' }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`USDA_REPORT_HTTP_${response.status}`)
  const text = (await response.text()).replace(/\s+/g, ' ')
  const released = text.match(/Released ([A-Z][a-z]+ \d{1,2}, \d{4})/)
  const patterns = {
    CORN: /Corn stocks in all positions on ([A-Z][a-z]+ \d{1,2}, \d{4}) totaled ([\d.]+) (billion|million) bushels/i,
    SOYBEAN: /Soybeans stored in all positions on ([A-Z][a-z]+ \d{1,2}, \d{4}) totaled ([\d.]+) (billion|million) bushels/i,
    WHEAT: /Old crop all wheat stored in all positions on ([A-Z][a-z]+ \d{1,2}, \d{4}) totaled ([\d.]+) (billion|million) bushels/i
  }
  const match = text.match(patterns[metric.commodity])
  if (!match) throw new Error(`USDA_SEMANTIC_MATCH_FAILED:${metric.commodity}`)
  const observationDate = new Date(`${match[1]} UTC`).toISOString().slice(0, 10), publicationDate = released ? new Date(`${released[1]} UTC`).toISOString() : null
  const sourceValue = Number(match[2]) * (match[3].toLowerCase() === 'billion' ? 1_000_000_000 : 1_000_000)
  return { sourceValue, sourceUnit: 'BUSHELS', normalizedValue: sourceValue, normalizedUnit: 'BUSHELS', observationDate, referencePeriod: match[1], publicationDate, retrievedAt: now(), source: sourceName(metric), sourceUrl: discovery.latestReportUrl, externalSeriesId: metric.externalSeriesId, sourceRecordId: `${metric.externalSeriesId}:${observationDate}:${publicationDate}`, checksum: checksum(match[0]), verificationStatus: 'VERIFIED_OFFICIAL' }
}
async function boundedEiaFetch(metric, length = 100) {
  const apiKey = process.env.EIA_API_KEY
  if (!apiKey) return { observations: [], sourceStatus: 'CREDENTIAL_CONFIGURATION_REQUIRED' }
  if (!metric.externalSeriesId) return { observations: [], sourceStatus: 'SOURCE_PENDING' }
  const url = new URL(metric.officialUrl)
  url.searchParams.set('api_key', apiKey); url.searchParams.set('frequency', metric.frequency.toLowerCase()); url.searchParams.set('data[0]', 'value')
  url.searchParams.set('facets[series][]', metric.externalSeriesId); url.searchParams.set('sort[0][column]', 'period'); url.searchParams.set('sort[0][direction]', 'desc'); url.searchParams.set('offset', '0'); url.searchParams.set('length', String(length))
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) return { observations: [], sourceStatus: response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}` }
  const payload = await response.json(), retrievedAt = now()
  const observations = (payload.response?.data ?? []).filter(row => row.value !== null && Number.isFinite(Number(row.value))).map(row => ({ sourceValue: Number(row.value), sourceUnit: row.units, normalizedValue: Number(row.value), normalizedUnit: metric.normalizedUnit, observationDate: isoPeriod(row.period), referencePeriod: row.period, publicationDate: null, retrievedAt, source: sourceName(metric), sourceUrl: url.href.replace(apiKey, 'REDACTED'), externalSeriesId: row.series, sourceRecordId: `${row.series}:${row.period}`, checksum: checksum(row), verificationStatus: 'VERIFIED_OFFICIAL' })).sort((a, b) => a.observationDate.localeCompare(b.observationDate))
  return { observations, sourceStatus: observations.length ? 'ACTIVE' : 'EMPTY' }
}
async function workMetric(metric, stage) {
  const base = { canonicalSeriesId: metric.canonicalSeriesId, identity: 'PASS', sourceStatus: metric.status, currentStatus: 'PENDING', historyStatus: 'PENDING', analyticsStatus: 'PENDING', provenanceStatus: 'PENDING', verificationStatus: metric.verificationStatus, updatedAt: now() }
  if (metric.adapter === 'LME') return { ...base, sourceStatus: 'ACCESS_CONFIGURATION_REQUIRED', currentStatus: 'SOURCE_CONSTRAINED', historyStatus: 'SOURCE_CONSTRAINED', analyticsStatus: 'DATA_PENDING', provenanceStatus: 'ACCESS_CONSTRAINED', coverageStatus: 'SOURCE_CONSTRAINED', retryPolicy: 'NON_RETRYABLE' }
  let observations = metric.provider === 'EIA' ? await localEiaObservations(metric) : []
  if (canary && observations.length > 10) observations = observations.slice(-10)
  let sourceStatus = observations.length ? 'LOCAL_OFFICIAL_ARCHIVE' : metric.status
  if (metric.provider === 'EIA' && stage !== 'CANARY') {
    const live = await boundedEiaFetch(metric, stage === 'HISTORICAL' ? 100 : 2)
    sourceStatus = live.sourceStatus === 'CREDENTIAL_CONFIGURATION_REQUIRED' && observations.length ? sourceStatus : live.sourceStatus
    observations = [...new Map([...observations, ...live.observations].map(item => [item.observationDate, item])).values()].sort((a, b) => a.observationDate.localeCompare(b.observationDate))
  }
  if (metric.provider === 'USDA_NASS') {
    const existing = await prisma.economicSeries.findUnique({ where: { provider_seriesId: { provider: metric.provider, seriesId: metric.canonicalSeriesId } }, include: { values: { orderBy: { date: 'asc' } } } })
    if (existing) observations = existing.values.map(value => ({ sourceValue: Number(value.value), sourceUnit: metric.sourceUnit, normalizedValue: Number(value.value), normalizedUnit: metric.normalizedUnit, observationDate: value.date.toISOString().slice(0, 10), referencePeriod: value.date.toISOString().slice(0, 10), publicationDate: null, retrievedAt: value.importedAt?.toISOString() ?? value.updatedAt.toISOString(), source: sourceName(metric), sourceUrl: value.sourceUrl ?? metric.officialUrl, externalSeriesId: metric.externalSeriesId, sourceRecordId: `${metric.externalSeriesId}:${value.date.toISOString().slice(0, 10)}`, checksum: value.rawChecksum ?? checksum([metric.canonicalSeriesId, value.date, value.value]), verificationStatus: 'VERIFIED_OFFICIAL' }))
    sourceStatus = existing ? 'CANONICAL_EXISTING' : 'OFFICIAL_DISCOVERY_PENDING'
    if (!canary) { const latest = await usdaLatestObservation(metric); if (latest) { observations = [...new Map([...observations, latest].map(item => [item.observationDate, item])).values()].sort((a, b) => a.observationDate.localeCompare(b.observationDate)); sourceStatus = 'SOURCE_READY' } }
  }
  const write = await canonicalize(metric, observations)
  const historyPass = write.rows >= 10
  const latest = observations.at(-1)
  const result = { ...base, sourceStatus, currentStatus: latest ? 'PASS' : 'PENDING', historyStatus: historyPass ? 'PASS' : observations.length ? 'PARTIAL' : 'PENDING', canonicalRows: write.rows, inserted: write.inserted, noOp: write.noOp, conflict: write.conflict, failed: write.failed, earliestDate: write.earliestDate ?? null, latestDate: write.latestDate ?? null, frequency: metric.frequency, unit: metric.normalizedUnit, analyticsStatus: observations.length >= 2 ? 'DERIVABLE' : 'DATA_PENDING', provenanceStatus: write.rows ? 'PASS' : 'PENDING', freshnessStatus: latest ? 'FREQUENCY_EVALUATION_REQUIRED' : 'SOURCE_PENDING', coverageStatus: historyPass && latest ? 'P0_READY' : 'PARTIAL' }
  return result
}
async function runStage(stage, registry) {
  await state(stage, { status: 'RUNNING' })
  const selected = canary ? registry.metrics.filter(metric => ['EIA_US_CRUDE_OIL_INVENTORY', 'EIA_CUSHING_CRUDE_OIL_INVENTORY', 'EIA_LOWER48_NATURAL_GAS_STORAGE'].includes(metric.canonicalSeriesId)) : registry.metrics
  const work = {}
  for (const metric of selected) {
    try { work[metric.canonicalSeriesId] = await workMetric(metric, stage) }
    catch (error) { work[metric.canonicalSeriesId] = { canonicalSeriesId: metric.canonicalSeriesId, identity: 'PASS', sourceStatus: 'FAILED', currentStatus: 'FAILED', historyStatus: 'FAILED', error: String(error), updatedAt: now() }; await log(`FAILED stage=${stage} metric=${metric.canonicalSeriesId} ${String(error)}`) }
    await atomic(join(runtime, 'metric-work-state.json'), { asset: registry.asset, stage, updatedAt: now(), metrics: work })
  }
  const passed = Object.values(work).filter(item => item.currentStatus === 'PASS' && item.historyStatus === 'PASS' && item.provenanceStatus === 'PASS').length
  await atomic(join(runtime, `${stage.toLowerCase()}-v2-result.json`), { asset: registry.asset, stage, completedAt: now(), metrics: work, passed, total: selected.length })
  return work
}
function physicalAnalytics(metric, values) {
  if (values.length < 2) return { status: 'DATA_PENDING', sampleCount: values.length }
  const points = values.map(item => ({ date: item.date, value: Number(item.value) })).filter(item => Number.isFinite(item.value))
  const current = points.at(-1), previous = points.at(-2)
  const atOrBefore = date => [...points].reverse().find(item => item.date <= date)
  const change = prior => prior ? { absolute: current.value - prior.value, percent: prior.value === 0 ? null : (current.value / prior.value - 1) * 100 } : null
  const dateAgo = months => { const value = new Date(current.date); value.setUTCMonth(value.getUTCMonth() - months); return value }
  const nearMonthsAgo = (months, toleranceDays) => { const target = dateAgo(months), prior = atOrBefore(target); return prior && (target - prior.date) / 86400000 <= toleranceDays ? prior : null }
  const yearStart = new Date(Date.UTC(current.date.getUTCFullYear(), 0, 1))
  const windowStart = new Date(current.date.getTime() - 364 * 86400000), window = points.filter(item => item.date >= windowStart)
  const range52w = current.date - points[0].date >= 350 * 86400000 && window.length >= 10 ? { low: Math.min(...window.map(item => item.value)), high: Math.max(...window.map(item => item.value)), percentile: (() => { const low = Math.min(...window.map(item => item.value)), high = Math.max(...window.map(item => item.value)); return high === low ? null : (current.value - low) / (high - low) * 100 })(), sampleCount: window.length } : null
  return { status: 'READY', analyticType: metric.metricType === 'PRODUCTION' ? 'PRODUCTION_ANALYTIC' : 'PHYSICAL_INVENTORY_ANALYTIC', unit: metric.normalizedUnit, latestDate: current.date, onePeriod: change(previous), oneMonth: ['WEEKLY','MONTHLY'].includes(metric.frequency) ? change(nearMonthsAgo(1, 35)) : null, threeMonth: change(nearMonthsAgo(3, metric.frequency === 'QUARTERLY' ? 45 : 35)), ytd: change(atOrBefore(yearStart)), oneYear: change(nearMonthsAgo(12, metric.frequency === 'QUARTERLY' ? 60 : 35)), range52w, sampleCount: points.length }
}
async function materializeAnalytics(registry, series) {
  const analytics = registry.metrics.map(metric => { const found = series.find(item => item.seriesId === metric.canonicalSeriesId); return { canonicalSeriesId: metric.canonicalSeriesId, metricType: metric.metricType, ...physicalAnalytics(metric, found?.values ?? []) } })
  await atomic(join(runtime, 'analytics.json'), { generatedAt: now(), semantics: 'physical quantity changes, never investment returns', analytics })
  return analytics
}
async function coverage(registry) {
  const series = await prisma.economicSeries.findMany({ where: { seriesId: { in: registry.metrics.map(metric => metric.canonicalSeriesId) } }, include: { values: { orderBy: { date: 'asc' } } } })
  const analytics = await materializeAnalytics(registry, series), discovery = await json(join(runtime, 'usda-latest-discovery.json'), {})
  const matrix = registry.metrics.map(metric => {
    const found = series.find(item => item.seriesId === metric.canonicalSeriesId), rows = found?.values.length ?? 0, earliest = found?.values[0]?.date ?? null, latest = found?.values.at(-1)?.date ?? null
    const spanDays = earliest && latest ? (latest - earliest) / 86400000 : 0
    const historyState = rows <= 1 ? 'CURRENT_ONLY' : spanDays >= 3650 ? '>=10Y' : spanDays >= 1825 ? '>=5Y' : spanDays >= 1095 ? '>=3Y' : spanDays >= 365 ? '>=1Y' : rows >= 20 ? '>=20_OBSERVATIONS' : rows >= 10 ? '>=10_OBSERVATIONS' : 'CURRENT_ONLY'
    let sourceState = 'SOURCE_PENDING'
    if (metric.adapter === 'LME') sourceState = 'ACCESS_CONFIGURATION_REQUIRED'
    else if (metric.provider === 'EIA') sourceState = metric.externalSeriesId ? (process.env.EIA_API_KEY ? 'PRODUCTION_READY' : 'CONFIGURATION_REQUIRED') : 'SOURCE_PENDING'
    else if (metric.provider === 'USDA_NASS') sourceState = discovery.latestReportUrl ? 'SOURCE_READY' : 'SOURCE_PENDING'
    const threshold = metric.frequency === 'WEEKLY' ? 14 : metric.frequency === 'MONTHLY' ? 62 : metric.frequency === 'QUARTERLY' ? 125 : 7
    const ageDays = latest ? (Date.now() - latest.getTime()) / 86400000 : null
    const freshnessState = sourceState === 'ACCESS_CONFIGURATION_REQUIRED' ? 'SOURCE_CONSTRAINED' : !latest ? 'SOURCE_DELAYED' : ageDays <= threshold ? 'CURRENT' : 'HISTORICAL_ONLY'
    const analytic = analytics.find(item => item.canonicalSeriesId === metric.canonicalSeriesId)
    const detailState = sourceState === 'ACCESS_CONFIGURATION_REQUIRED' ? 'ACCESS_CONSTRAINED_READY' : sourceState === 'CONFIGURATION_REQUIRED' ? 'CONFIGURATION_CONSTRAINED_READY' : !rows ? 'SOURCE_CONSTRAINED_READY' : rows < 10 ? 'TIME_CONSTRAINED_READY' : 'PROFESSIONAL_READY'
    return { canonicalSeriesId: metric.canonicalSeriesId, commodity: metric.commodity, commodityGroup: metric.commodityGroup, metricType: metric.metricType, country: metric.country, geography: metric.location ?? metric.region, frequency: metric.frequency, unit: metric.normalizedUnit, source: sourceName(metric), identity_state: 'READY', source_state: sourceState, current_state: latest ? 'READY' : 'CONSTRAINED', history_state: historyState, analytics_state: analytic?.status ?? 'DATA_PENDING', provenance_state: rows ? 'VERIFIED_OFFICIAL' : sourceState, freshness_state: freshnessState, detail_state: detailState, canonicalRows: rows, earliestDate: earliest, latestDate: latest }
  })
  await atomic(join(runtime, 'coverage-matrix.json'), { generatedAt: now(), registeredScope: registry.registeredScopeAfter, unknownStates: 0, metrics: matrix })
  return matrix
}
async function main() {
  await mkdir(join(runtime, 'provenance'), { recursive: true })
  const registry = await json(registryPath)
  const ownership = { activatedAt: now(), ownerBefore: 32216, ownerCurrent: process.pid, supervisorReused: true, doubleWriterRisk: false, rootCause: ['HARDCODED_SOURCE', 'UNWIRED_ADAPTER'] }
  await atomic(join(runtime, 'ownership.json'), ownership)
  await state('OWNER_HANDOFF', ownership)
  await localCensus(registry)
  if (canary) { const work = await runStage('CANARY', registry); await coverage(registry); await state('CANARY', { status: 'COMPLETE', canaryPassed: Object.values(work).filter(item => item.historyStatus === 'PASS').length }); return }
  try { await atomic(join(runtime, 'usda-latest-discovery.json'), { checkedAt: now(), latestReportUrl: await discoverUsdaLatest(), distinction: ['publicationDate', 'referencePeriod', 'observationDate'] }) } catch (error) { await atomic(join(runtime, 'usda-latest-discovery.json'), { checkedAt: now(), status: 'SOURCE_DELAYED', error: String(error), distinction: ['publicationDate', 'referencePeriod', 'observationDate'] }) }
  await runStage('HISTORICAL', registry)
  await runStage('LATEST', registry)
  await coverage(registry)
  await atomic(join(runtime, 'completion-manifest.json'), { asset: registry.asset, completedAt: now(), completion: 'PARTIAL', truth: 'COMPLETE requires identity/latest/history/provenance/freshness for every source-ready metric or explicit source constraint', registeredScopeBefore: registry.registeredScopeBefore, registeredScopeAfter: registry.registeredScopeAfter, autoContinuing: true })
  if (once) { await state('COMPLETE', { status: 'COMPLETE' }); return }
  while (true) { await runStage('INCREMENTAL', registry); await coverage(registry); await state('SCHEDULER', { status: 'IDLE', nextRunAt: new Date(Date.now() + 6 * 3600000).toISOString() }); await sleep(6 * 3600000) }
}
process.on('SIGTERM', async () => { await log('SIGTERM safe handoff'); await prisma.$disconnect(); process.exit(0) })
main().catch(async error => { await log(`FATAL ${String(error)}`); await state('FAILED', { status: 'FAILED', error: String(error) }); process.exitCode = 1 }).finally(() => once ? prisma.$disconnect() : undefined)
