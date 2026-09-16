import { parseSdmxJsonObservations, type SdmxJsonResponse } from "../../../services/economicIngestion/sdmxJsonParser.ts";
import type { ProviderAdapter, ProviderFetchRequest, ProviderPoint, ProviderValidation } from "../ProviderAdapter.ts";

const CLI_URL = "https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI/.M.LI...AA...H?dimensionAtObservation=AllDimensions&format=jsondata";
const pppUrl = (country: string) => `https://sdmx.oecd.org/public/rest/data/OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE4,2.0/A.${country}...PPP_B1GQ.......?startPeriod=2022&dimensionAtObservation=AllDimensions`;

/** Official OECD SDMX adapter for the currently registered CLI universe. */
export class OecdProviderAdapter implements ProviderAdapter {
  readonly id = "OECD";
  readonly supportedAssetClasses = ["MACRO"] as const;
  private readonly points = new Map<string, Promise<ProviderPoint[]>>();

  source() { return { provider: "OECD", method: "OECD_SDMX_JSON_2_0" }; }
  fetchLatest(request: ProviderFetchRequest) { return this.fetch(request); }
  async latestAvailableDate(request: ProviderFetchRequest) { return (await this.fetch(request)).at(-1)?.date ?? null; }
  fetchHistorical(request: ProviderFetchRequest) { return this.fetch(request); }
  normalize(payload: unknown): ProviderPoint[] { return payload as ProviderPoint[]; }
  validate(points: ProviderPoint[]): ProviderValidation { return points.length ? { valid: true } : { valid: false, reason: "OECD_NO_DATA" }; }

  private async fetch(request: ProviderFetchRequest): Promise<ProviderPoint[]> {
    const [dataset, country] = request.instrument.symbol.split(":");
    if (!country || !["CLI", "PPP"].includes(dataset)) throw new Error(`OECD_UNSUPPORTED_SERIES_ID:${request.instrument.symbol}`);
    const url = dataset === "CLI" ? CLI_URL : pppUrl(country);
    if (!this.points.has(url)) this.points.set(url, (async () => {
      const isPpp = dataset === "PPP";
      const response = await fetch(url, { headers: { Accept: isPpp ? "text/csv" : "application/json" }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`OECD_HTTP_${response.status}`);
      if (!isPpp) {
        return parseSdmxJsonObservations(await response.json() as SdmxJsonResponse)
          .filter((row) => row.dimensions.REF_AREA === country && row.value !== null && Number.isFinite(row.value))
          .map((row) => ({ date: new Date(`${row.dimensions.TIME_PERIOD}-01T00:00:00.000Z`), value: row.value }));
      }
      const lines = (await response.text()).trim().split(/\r?\n/);
      const header = lines.shift()?.split(",") ?? [];
      const timeIndex = header.indexOf("TIME_PERIOD");
      const valueIndex = header.indexOf("OBS_VALUE");
      if (timeIndex < 0 || valueIndex < 0) throw new Error("OECD_PPP_SCHEMA_MISMATCH");
      return lines.map((line) => line.split(","))
        .map((columns) => ({ date: new Date(`${columns[timeIndex]}-01-01T00:00:00.000Z`), value: Number(columns[valueIndex]) }));
    })());
    const points = (await this.points.get(url)!)
      .filter((point) => point.value !== null && Number.isFinite(point.value))
      .filter((point) => !Number.isNaN(point.date.getTime()) && point.date.getTime() <= Date.now() + 86_400_000)
      .sort((left, right) => left.date.getTime() - right.date.getTime())
      .filter((point) => !request.startDate || point.date >= request.startDate).filter((point) => !request.endDate || point.date <= request.endDate);
    const validation = this.validate(points);
    if (!validation.valid) throw new Error(validation.reason);
    return points;
  }
}
