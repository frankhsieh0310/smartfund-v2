import { readFile } from "node:fs/promises";
import path from "node:path";

const root = () => path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield"), "serving");
async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")); }

export async function listGovernmentYieldSeries(filters: Record<string, string | null>) {
  const identities = await json<{ rows: Array<Record<string, unknown>> }>(path.join(root(), "identities.json"));
  const analytics = await json<{ rows: Array<Record<string, unknown> & { canonicalId: string }> }>(path.join(root(), "analytics", "series.json"));
  const analyticsById = new Map(analytics.rows.map((row) => [row.canonicalId, row]));
  const query = filters.query?.toLowerCase();
  return identities.rows.filter((row) => {
    if (query && ![row.canonicalId, row.officialName, row.jurisdiction, row.authority, row.tenor].some((value) => String(value).toLowerCase().includes(query))) return false;
    for (const field of ["jurisdiction", "currency", "tenor", "curveType", "authority", "officialSource"]) if (filters[field] && String(row[field]) !== filters[field]) return false;
    return true;
  }).map((row) => ({ ...row, analytics: analyticsById.get(String(row.canonicalId)) }));
}

export async function getGovernmentYieldDetail(canonicalId: string) {
  const identities = await json<{ rows: Array<Record<string, unknown> & { canonicalId: string }> }>(path.join(root(), "identities.json"));
  const identity = identities.rows.find((row) => row.canonicalId === canonicalId);
  if (!identity) return null;
  const history = await json<Record<string, unknown>>(path.join(root(), "history", `${canonicalId}.json`));
  const analytics = await json<{ rows: Array<Record<string, unknown> & { canonicalId: string }> }>(path.join(root(), "analytics", "series.json"));
  const curves = await json<{ rows: Array<Record<string, unknown> & { points: Array<{ seriesId: string }> }> }>(path.join(root(), "analytics", "curves.json"));
  return { identity, history, analytics: analytics.rows.find((row) => row.canonicalId === canonicalId), curveContext: curves.rows.filter((curve) => curve.points.some((point) => point.seriesId === canonicalId)) };
}

export async function getGovernmentYieldContracts() { return json(path.join(root(), "contracts.json")); }
