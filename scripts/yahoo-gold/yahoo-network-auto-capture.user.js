// ==UserScript==
// @name         SmartFund Yahoo Network Auto Capture
// @namespace    https://smartfund.app/
// @version      1.0.5
// @downloadURL  https://raw.githubusercontent.com/frankhsieh0310/smartfund-v2/master/scripts/yahoo-gold/yahoo-network-auto-capture.user.js
// @updateURL    https://raw.githubusercontent.com/frankhsieh0310/smartfund-v2/master/scripts/yahoo-gold/yahoo-network-auto-capture.user.js
// @description  Saves a sanitized network capture after a Yahoo Finance Export or Download click.
// @match        https://finance.yahoo.com/*
// @run-at       document-start
// @grant        GM_download
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const pageDocument = page.document;
  const pageConsole = page.console || console;
  const log = (...args) => pageConsole.log(...args);
  const logError = (...args) => pageConsole.error(...args);
  const INSTALL_KEY = "__SMARTFUND_YAHOO_NETWORK_AUTO_CAPTURE__";
  const BADGE_ID = "smartfund-yahoo-capture-status";
  const MAX_BODY_LENGTH = 5_000;
  const EXPORT_DELAY_MS = 2_500;
  const GM_DOWNLOAD_TIMEOUT_MS = 5_000;
  const valuationKeywords = ["Market Cap", "Enterprise Value", "Trailing P/E", "Forward P/E", "Price/Sales", "Price/Book", "PeRatio", "ForwardPeRatio", "MarketCap", "EnterpriseValue"];
  const sensitiveKey = /(?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)/i;
  const hookState = { fetch: false, xhr: false, blob: false };

  const showStatus = (message, isError = false) => {
    const render = () => {
      const root = pageDocument.body || pageDocument.documentElement;
      if (!root) { setTimeout(render, 50); return; }
      let badge = pageDocument.getElementById?.(BADGE_ID);
      if (!badge) {
        badge = pageDocument.createElement("div");
        badge.id = BADGE_ID;
        Object.assign(badge.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647", maxWidth: "360px", padding: "10px 12px", borderRadius: "8px", font: "600 12px/1.4 system-ui,sans-serif", color: "#fff", boxShadow: "0 4px 16px rgba(0,0,0,.35)", pointerEvents: "none" });
        root.appendChild(badge);
      }
      badge.style.background = isError ? "#b91c1c" : "#065f46";
      badge.textContent = `SMARTFUND CAPTURE ${message}`;
    };
    render();
  };

  log("SMARTFUND USERSCRIPT LOADED");
  log(page.location.href);
  showStatus("ACTIVE v1.0.4 | FETCH: -- | XHR: -- | BLOB: --");
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
    const isExportControl = (element) => /(?:download|export|\u4e0b\u8f09|\u532f\u51fa)/i.test([element?.innerText, element?.textContent, element?.getAttribute?.("aria-label"), element?.getAttribute?.("title")].filter(Boolean).join(" "));

    page.YAHOO_NETWORK_LOGS = [];
    page.fetch = async function smartfundAutoCaptureFetch(input, init = {}) {
      const response = await native.fetch(input, init);
      let responsePreview = "[BODY_UNAVAILABLE]";
      try { responsePreview = preview(await response.clone().text()); } catch {}
      add({ kind: "FETCH", method: String(init.method || (input instanceof page.Request ? input.method : "GET")).toUpperCase(), requestUrl: sanitizeUrl(input instanceof page.Request ? input.url : String(input)), status: response.status, contentType: response.headers.get("content-type"), bodyPreview: responsePreview, containsValuationKeywords: isValuation(responsePreview) });
      return response;
    };
    hookState.fetch = true;
    log("FETCH HOOKED");
    showStatus("ACTIVE v1.0.4 | FETCH: ON | XHR: -- | BLOB: --");

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
    hookState.xhr = true;
    log("XHR HOOKED");
    showStatus("ACTIVE v1.0.4 | FETCH: ON | XHR: ON | BLOB: --");

    page.URL.createObjectURL = function smartfundAutoCaptureBlob(blob) {
      const objectUrl = native.createObjectURL(blob);
      Promise.resolve(blob?.text?.()).then((text) => {
        const blobPreview = preview(text || "");
        add({ kind: "BLOB", method: null, requestUrl: objectUrl, status: null, contentType: blob?.type || null, blobMimeType: blob?.type || null, blobSize: blob?.size ?? null, bodyPreview: blobPreview, containsValuationKeywords: isValuation(blobPreview) });
      }).catch(() => add({ kind: "BLOB", method: null, requestUrl: objectUrl, status: null, contentType: blob?.type || null, blobMimeType: blob?.type || null, blobSize: blob?.size ?? null, bodyPreview: "[BLOB_TEXT_UNAVAILABLE]", containsValuationKeywords: false }));
      return objectUrl;
    };
    hookState.blob = true;
    log("BLOB HOOKED");
    showStatus("ACTIVE v1.0.4 | FETCH: ON | XHR: ON | BLOB: ON");

    let pendingExport = null;
    const downloadSanitizedCapture = () => {
      log("GENERATING JSON");
      showStatus("GENERATING JSON");
      try {
        const json = JSON.stringify(page.YAHOO_NETWORK_LOGS, null, 2);
        const blob = new page.Blob([json], { type: "application/json" });
        const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
        let completed = false;
        let fallbackTimer = null;
        const fallbackDownload = (reason) => {
          if (completed) return;
          completed = true;
          if (fallbackTimer) clearTimeout(fallbackTimer);
          logError("GM_DOWNLOAD FALLBACK", reason);
          showStatus("BLOB FALLBACK");
          try {
            const href = native.createObjectURL(blob);
            const anchor = pageDocument.createElement("a");
            anchor.href = href;
            anchor.download = "yahoo-network-sanitized.json";
            anchor.style.display = "none";
            (pageDocument.documentElement || pageDocument.body).appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => native.revokeObjectURL(href), 1_000);
            log("BLOB FALLBACK CLICKED");
            showStatus("JSON DOWNLOADED");
          } catch (error) {
            logError("BLOB FALLBACK FAILED", error);
            showStatus(`ERROR: ${error?.message || error}`, true);
          }
        };
        const complete = () => {
          if (completed) return;
          completed = true;
          if (fallbackTimer) clearTimeout(fallbackTimer);
          log("JSON DOWNLOADED");
          showStatus("JSON DOWNLOADED");
        };
        if (typeof GM_download === "function") {
          log("GM_DOWNLOAD CALLED");
          fallbackTimer = setTimeout(() => fallbackDownload("GM_DOWNLOAD_TIMEOUT"), GM_DOWNLOAD_TIMEOUT_MS);
          const result = GM_download({ url: dataUrl, name: "yahoo-network-sanitized.json", saveAs: false, onload: complete, onerror: (error) => fallbackDownload(error?.error || error || "GM_DOWNLOAD_ERROR") });
          if (result && typeof result.then === "function") result.catch((error) => fallbackDownload(error?.message || error || "GM_DOWNLOAD_REJECTED"));
          return;
        }
        fallbackDownload("GM_DOWNLOAD_UNAVAILABLE");
      } catch (error) {
        logError("JSON GENERATION FAILED", error);
        showStatus(`ERROR: ${error?.message || error}`, true);
      }
    };
    pageDocument.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const controls = [event.target, ...(event.composedPath?.() || [])];
      const control = controls.find((candidate) => isExportControl(candidate)) || event.target?.closest?.("button,a,[role='button']");
      if (!isExportControl(control)) return;
      log("DOWNLOAD CLICK DETECTED");
      showStatus("CLICK DETECTED");
      add({ kind: "MARK", label: "before-download", method: null, requestUrl: null, status: null, contentType: null, bodyPreview: "", containsValuationKeywords: false });
      clearTimeout(pendingExport);
      pendingExport = setTimeout(downloadSanitizedCapture, EXPORT_DELAY_MS);
    }, true);
    page[INSTALL_KEY] = true;
  } catch (error) {
    logError("SMARTFUND USERSCRIPT FAILED", error);
    showStatus(`ERROR: ${error?.message || error}`, true);
  }
})();
