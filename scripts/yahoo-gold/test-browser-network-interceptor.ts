import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { analyzeInterceptorCapture } from "./analyze-request.ts";

class FakeHeaders {
  constructor(private readonly values: Record<string, string>) {}
  get(name: string) { return this.values[name.toLowerCase()] ?? null; }
}

class FakeResponse {
  readonly headers = new FakeHeaders({ "content-type": "application/json" });
  readonly status = 200;
  constructor(private readonly value: string) {}
  clone() { return new FakeResponse(this.value); }
  async text() { return this.value; }
}

class FakeXmlHttpRequest {
  static responseText = '{"MarketCap":123,"token":"must-not-leak"}';
  status = 200;
  responseText = FakeXmlHttpRequest.responseText;
  private listeners = new Map<string, Array<() => void>>();
  open(_method: string, _url: string) {}
  send() { setTimeout(() => this.listeners.get("loadend")?.forEach((listener) => listener()), 0); }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  getResponseHeader(name: string) { return name.toLowerCase() === "content-type" ? "application/json" : null; }
}

class BrowserUrl extends URL {
  static counter = 0;
  static createObjectURL(_blob: Blob) { return `blob:offline-${++BrowserUrl.counter}`; }
  static revokeObjectURL(_url: string) {}
}

async function main() {
  const source = await readFile(new URL("./browser-network-interceptor.js", import.meta.url), "utf8");
  const browserWindow: Record<string, unknown> = {
    location: { href: "https://finance.yahoo.com/quote/AAPL/key-statistics/" },
    fetch: async () => new FakeResponse('{"Market Cap":100,"crumb":"must-not-leak"}'),
    XMLHttpRequest: FakeXmlHttpRequest,
    URL: BrowserUrl,
    Blob,
    Request,
    setTimeout,
    clearTimeout,
    console,
    document: { createElement: () => ({ click() {}, href: "", download: "" }) },
  };
  const context = vm.createContext({ window: browserWindow, XMLHttpRequest: FakeXmlHttpRequest, URL: BrowserUrl, Blob, Request, setTimeout, clearTimeout, console });
  vm.runInContext(source, context, { filename: "browser-network-interceptor.js" });
  await (browserWindow.fetch as (url: string) => Promise<FakeResponse>)("https://example.test/data?ticker=AAPL&crumb=must-not-leak");
  const xhr = new FakeXmlHttpRequest();
  xhr.open("GET", "https://example.test/fundamentals?symbol=AAPL&token=must-not-leak");
  xhr.send();
  (browserWindow.URL as typeof BrowserUrl).createObjectURL(new Blob(["Market Cap,token=must-not-leak"], { type: "text/csv" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const logs = browserWindow.YAHOO_NETWORK_LOGS as Array<{ kind: string; requestUrl: string; bodyPreview: string }>;
  if (!["FETCH", "XHR", "BLOB"].every((kind) => logs.some((entry) => entry.kind === kind))) throw new Error("OFFLINE_INTERCEPTOR_EVENT_MISSING");
  if (JSON.stringify(logs).includes("must-not-leak")) throw new Error("SENSITIVE_VALUE_NOT_REDACTED");
  const analysis = analyzeInterceptorCapture(logs);
  if (analysis.captureType !== "YAHOO_NETWORK_INTERCEPTOR" || analysis.requestCount !== 3) throw new Error("INTERCEPTOR_ANALYSIS_FAILED");
  console.log(JSON.stringify({ status: "PASS", intercepted: logs.map((entry) => entry.kind), analysis }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
