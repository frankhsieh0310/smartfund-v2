import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeHeaders {
  get(name: string) { return name.toLowerCase() === "content-type" ? "application/json" : null; }
}
class FakeResponse {
  readonly headers = new FakeHeaders();
  readonly status = 200;
  clone() { return this; }
  async text() { return '{"MarketCap":1,"token":"must-not-leak"}'; }
}
class FakeXhr {
  status = 200;
  responseText = '{"EnterpriseValue":2,"crumb":"must-not-leak"}';
  private listeners = new Map<string, Array<() => void>>();
  open(_method: string, _url: string) {}
  send() { setTimeout(() => this.listeners.get("loadend")?.forEach((listener) => listener()), 0); }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  getResponseHeader(name: string) { return name.toLowerCase() === "content-type" ? "application/json" : null; }
}
class BrowserUrl extends URL {
  static blobs = new Map<string, Blob>();
  static sequence = 0;
  static createObjectURL(blob: Blob) { const url = `blob:test-${++BrowserUrl.sequence}`; BrowserUrl.blobs.set(url, blob); return url; }
  static revokeObjectURL(url: string) { BrowserUrl.blobs.delete(url); }
}

async function main() {
  const source = await readFile(new URL("./yahoo-network-auto-capture.user.js", import.meta.url), "utf8");
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  let downloadedHref = "";
  let downloadedJson = "";
  const root = { appendChild() {} };
  const document = {
    documentElement: root,
    body: root,
    addEventListener(name: string, listener: (event: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
    createElement: () => ({ href: "", download: "", style: {}, click() { downloadedHref = this.href; }, remove() {} }),
  };
  const windowObject: Record<string, unknown> = {
    location: { href: "https://finance.yahoo.com/quote/AAPL/key-statistics/" },
    fetch: async () => new FakeResponse(), XMLHttpRequest: FakeXhr, URL: BrowserUrl, Blob, Request, document, setTimeout, clearTimeout,
  };
  const GM_download = ({ url, onload }: { url: string; onload: () => void }) => {
    downloadedJson = decodeURIComponent(url.split(",", 2)[1] ?? "");
    onload();
  };
  const context = vm.createContext({ window: windowObject, unsafeWindow: windowObject, GM_download, XMLHttpRequest: FakeXhr, URL: BrowserUrl, Blob, Request, document, setTimeout, clearTimeout, console });
  vm.runInContext(source, context, { filename: "yahoo-network-auto-capture.user.js" });
  await (windowObject.fetch as (url: string) => Promise<FakeResponse>)("https://example.test/valuation?ticker=AAPL&token=must-not-leak");
  const xhr = new FakeXhr(); xhr.open("GET", "https://example.test/valuation?symbol=AAPL&crumb=must-not-leak"); xhr.send();
  (windowObject.URL as typeof BrowserUrl).createObjectURL(new Blob(["Market Cap,session=must-not-leak"], { type: "text/csv" }));
  for (const listener of listeners.get("click") ?? []) listener({ isTrusted: true, target: { closest: () => ({ innerText: "Download CSV", textContent: "Download CSV", getAttribute: () => null }) } });
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  const downloaded = BrowserUrl.blobs.get(downloadedHref);
  const json = downloadedJson || (downloaded ? await downloaded.text() : "");
  if (!json.includes('"kind": "FETCH"') || !json.includes('"kind": "XHR"') || !json.includes('"kind": "BLOB"')) throw new Error("AUTOMATIC_DOWNLOAD_FAILED");
  if (json.includes("must-not-leak")) throw new Error("SENSITIVE_VALUE_NOT_REDACTED");
  console.log(JSON.stringify({ status: "PASS", downloadedFile: "yahoo-network-sanitized.json", intercepted: ["FETCH", "XHR", "BLOB"], sensitiveValues: "REDACTED" }, null, 2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
