// ==UserScript==
// @name         SmartFund Yahoo Network Auto Capture
// @namespace    https://smartfund.app/
// @version      1.0.0
// @description  Saves a sanitized network capture after a Yahoo Finance Export or Download click.
// @match        https://finance.yahoo.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  const INSTALL_KEY = "__SMARTFUND_YAHOO_NETWORK_AUTO_CAPTURE__";
  const MAX_BODY_LENGTH = 5_000;
  const EXPORT_DELAY_MS = 2_500;
  const valuationKeywords = ["Market Cap", "Enterprise Value", "Trailing P/E", "Forward P/E", "Price/Sales", "Price/Book", "PeRatio", "ForwardPeRatio", "MarketCap", "EnterpriseValue"];
  const sensitiveKey = /(?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)/i;

  if (window[INSTALL_KEY]) return;

  const native = {
    fetch: window.fetch.bind(window),
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    createObjectURL: URL.createObjectURL.bind(URL),
    revokeObjectURL: URL.revokeObjectURL.bind(URL),
  };
  const redactText = (value) => String(value)
    .replace(/((?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)\s*[=:]\s*)([^&\s,;"'}]+)/gi, "$1[REDACTED]")
    .replace(/("(?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
  const sanitizeUrl = (rawUrl) => {
    try {
      const url = new URL(rawUrl, window.location.href);
      for (const [key] of url.searchParams) if (sensitiveKey.test(key)) url.searchParams.set(key, "[REDACTED]");
      return url.toString();
    } catch { return redactText(rawUrl); }
  };
  const bodyPreview = (value) => redactText(value).slice(0, MAX_BODY_LENGTH);
  const isValuation = (value) => valuationKeywords.some((keyword) => String(value).toLowerCase().includes(keyword.toLowerCase()));
  const add = (entry) => window.YAHOO_NETWORK_LOGS.push({ timestamp: new Date().toISOString(), ...entry });
  const isExportControl = (element) => /(?:download|export)/i.test([element?.innerText, element?.textContent, element?.getAttribute?.("aria-label"), element?.getAttribute?.("title")].filter(Boolean).join(" "));

  window.YAHOO_NETWORK_LOGS = [];
  window.fetch = async function smartfundAutoCaptureFetch(input, init = {}) {
    const response = await native.fetch(input, init);
    let preview = "[BODY_UNAVAILABLE]";
    try { preview = bodyPreview(await response.clone().text()); } catch {}
    add({ kind: "FETCH", method: String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase(), requestUrl: sanitizeUrl(input instanceof Request ? input.url : String(input)), status: response.status, contentType: response.headers.get("content-type"), bodyPreview: preview, containsValuationKeywords: isValuation(preview) });
    return response;
  };
  XMLHttpRequest.prototype.open = function smartfundAutoCaptureOpen(method, url, ...rest) {
    this.__smartfundYahooRequest = { method: String(method).toUpperCase(), requestUrl: sanitizeUrl(String(url)) };
    return native.xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function smartfundAutoCaptureSend(...args) {
    this.addEventListener("loadend", () => {
      const meta = this.__smartfundYahooRequest || { method: "GET", requestUrl: null };
      let preview = "[BODY_UNAVAILABLE]";
      try { preview = bodyPreview(this.responseText || ""); } catch {}
      add({ kind: "XHR", ...meta, status: this.status, contentType: this.getResponseHeader("content-type"), bodyPreview: preview, containsValuationKeywords: isValuation(preview) });
    }, { once: true });
    return native.xhrSend.apply(this, args);
  };
  URL.createObjectURL = function smartfundAutoCaptureBlob(blob) {
    const objectUrl = native.createObjectURL(blob);
    Promise.resolve(blob?.text?.()).then((text) => {
      const preview = bodyPreview(text || "");
      add({ kind: "BLOB", method: null, requestUrl: objectUrl, status: null, contentType: blob?.type || null, blobMimeType: blob?.type || null, blobSize: blob?.size ?? null, bodyPreview: preview, containsValuationKeywords: isValuation(preview) });
    }).catch(() => add({ kind: "BLOB", method: null, requestUrl: objectUrl, status: null, contentType: blob?.type || null, blobMimeType: blob?.type || null, blobSize: blob?.size ?? null, bodyPreview: "[BLOB_TEXT_UNAVAILABLE]", containsValuationKeywords: false }));
    return objectUrl;
  };

  let pendingExport = null;
  const downloadSanitizedCapture = () => {
    const blob = new Blob([JSON.stringify(window.YAHOO_NETWORK_LOGS, null, 2)], { type: "application/json" });
    const href = native.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "yahoo-network-sanitized.json";
    anchor.style.display = "none";
    (document.documentElement || document.body).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => native.revokeObjectURL(href), 1_000);
  };
  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const control = event.target?.closest?.("button,a,[role='button']");
    if (!isExportControl(control)) return;
    add({ kind: "MARK", label: "before-download", method: null, requestUrl: null, status: null, contentType: null, bodyPreview: "", containsValuationKeywords: false });
    clearTimeout(pendingExport);
    pendingExport = setTimeout(downloadSanitizedCapture, EXPORT_DELAY_MS);
  }, true);
  window[INSTALL_KEY] = true;
})();
