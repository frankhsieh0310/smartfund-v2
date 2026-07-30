// ==UserScript==
// @name         SmartFund Yahoo Network Auto Capture
// @namespace    https://smartfund.app/
// @version      1.0.1
// @description  Saves a sanitized network capture after a Yahoo Finance Export or Download click.
// @match        https://finance.yahoo.com/*
// @run-at       document-start
// @grant        GM_download
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  console.log("SMARTFUND USERSCRIPT LOADED");

  const INSTALL_KEY = "__SMARTFUND_YAHOO_NETWORK_AUTO_CAPTURE__";
  const MAX_BODY_LENGTH = 5_000;
  const EXPORT_DELAY_MS = 2_500;
  const valuationKeywords = ["Market Cap", "Enterprise Value", "Trailing P/E", "Forward P/E", "Price/Sales", "Price/Book", "PeRatio", "ForwardPeRatio", "MarketCap", "EnterpriseValue"];
  const sensitiveKey = /(?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)/i;
  const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const pageDocument = page.document;
  console.log(page.location.href);

  if (page[INSTALL_KEY]) return;

  try {
    const native = {
      fetch: page.fetch.bind(page),
      xhrOpen: page.XMLHttpRequest.prototype.open,
      xhrSend: page.XMLHttpRequest.prototype.send,
      createObjectURL: page.URL.createObjectURL.bind(page.URL),
      revokeObjectURL: page.URL.revokeObjectURL.bind(page.URL),
    };
    const redactText = (value) => String(value)
      .replace(/((?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)\s*[=:]\s*)([^&\s,;"'}]+)/gi, "$1[REDACTED]")
      .replace(/("(?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
    const sanitizeUrl = (rawUrl) => {
      try {
        const url = new URL(rawUrl, page.location.href);
        for (const [key] of url.searchParams) if (sensitiveKey.test(key)) url.searchParams.set(key, "[REDACTED]");
        return url.toString();
      } catch { return redactText(rawUrl); }
    };
    const preview = (value) => redactText(value).slice(0, MAX_BODY_LENGTH);
    const isValuation = (value) => valuationKeywords.some((keyword) => String(value).toLowerCase().includes(keyword.toLowerCase()));
    const add = (entry) => page.YAHOO_NETWORK_LOGS.push({ timestamp: new Date().toISOString(), ...entry });
    const isExportControl = (element) => /(?:download|export)/i.test([element?.innerText, element?.textContent, element?.getAttribute?.("aria-label"), element?.getAttribute?.("title")].filter(Boolean).join(" "));

    page.YAHOO_NETWORK_LOGS = [];
    page.fetch = async function smartfundAutoCaptureFetch(input, init = {}) {
      const response = await native.fetch(input, init);
      let responsePreview = "[BODY_UNAVAILABLE]";
      try { responsePreview = preview(await response.clone().text()); } catch {}
      add({ kind: "FETCH", method: String(init.method || (input instanceof page.Request ? input.method : "GET")).toUpperCase(), requestUrl: sanitizeUrl(input instanceof page.Request ? input.url : String(input)), status: response.status, contentType: response.headers.get("content-type"), bodyPreview: responsePreview, containsValuationKeywords: isValuation(responsePreview) });
      return response;
    };
    console.log("FETCH HOOKED");

    page.XMLHttpRequest.prototype.open = function smartfundAutoCaptureOpen(method, url, ...rest) {
      this.__smartfundYahooRequest = { method: String(method).toUpperCase(), requestUrl: sanitizeUrl(String(url)) };
      return native.xhrOpen.call(this, method, url, ...rest);
    };
    page.XMLHttpRequest.prototype.send = function smartfundAutoCaptureSend(...args) {
      this.addEventListener("loadend", () => {
        const meta = this.__smartfundYahooRequest || { method: "GET", requestUrl: null };
        let responsePreview = "[BODY_UNAVAILABLE]";
        try { responsePreview = preview(this.responseText || ""); } catch {}
        add({ kind: "XHR", ...meta, status: this.status, contentType: this.getResponseHeader("content-type"), bodyPreview: responsePreview, containsValuationKeywords: isValuation(responsePreview) });
      }, { once: true });
      return native.xhrSend.apply(this, args);
    };
    console.log("XHR HOOKED");

    page.URL.createObjectURL = function smartfundAutoCaptureBlob(blob) {
      const objectUrl = native.createObjectURL(blob);
      Promise.resolve(blob?.text?.()).then((text) => {
        const blobPreview = preview(text || "");
        add({ kind: "BLOB", method: null, requestUrl: objectUrl, status: null, contentType: blob?.type || null, blobMimeType: blob?.type || null, blobSize: blob?.size ?? null, bodyPreview: blobPreview, containsValuationKeywords: isValuation(blobPreview) });
      }).catch(() => add({ kind: "BLOB", method: null, requestUrl: objectUrl, status: null, contentType: blob?.type || null, blobMimeType: blob?.type || null, blobSize: blob?.size ?? null, bodyPreview: "[BLOB_TEXT_UNAVAILABLE]", containsValuationKeywords: false }));
      return objectUrl;
    };
    console.log("BLOB HOOKED");

    let pendingExport = null;
    const downloadSanitizedCapture = () => {
      console.log("GENERATING JSON");
      try {
        const json = JSON.stringify(page.YAHOO_NETWORK_LOGS, null, 2);
        const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
        if (typeof GM_download === "function") {
          GM_download({ url: dataUrl, name: "yahoo-network-sanitized.json", saveAs: false, onload: () => console.log("JSON DOWNLOADED"), onerror: (error) => console.error("JSON DOWNLOAD FAILED", error) });
          return;
        }
        const blob = new page.Blob([json], { type: "application/json" });
        const href = native.createObjectURL(blob);
        const anchor = pageDocument.createElement("a");
        anchor.href = href;
        anchor.download = "yahoo-network-sanitized.json";
        anchor.style.display = "none";
        (pageDocument.documentElement || pageDocument.body).appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => native.revokeObjectURL(href), 1_000);
        console.log("JSON DOWNLOADED");
      } catch (error) {
        console.error("JSON GENERATION FAILED", error);
      }
    };
    pageDocument.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const controls = [event.target, ...(event.composedPath?.() || [])];
      const control = controls.find((candidate) => isExportControl(candidate)) || event.target?.closest?.("button,a,[role='button']");
      if (!isExportControl(control)) return;
      console.log("DOWNLOAD CLICK DETECTED");
      add({ kind: "MARK", label: "before-download", method: null, requestUrl: null, status: null, contentType: null, bodyPreview: "", containsValuationKeywords: false });
      clearTimeout(pendingExport);
      pendingExport = setTimeout(downloadSanitizedCapture, EXPORT_DELAY_MS);
    }, true);
    page[INSTALL_KEY] = true;
  } catch (error) {
    console.error("SMARTFUND USERSCRIPT FAILED", error);
  }
})();
