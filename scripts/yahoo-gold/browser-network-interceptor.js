(() => {
  const INSTALL_KEY = "__SMARTFUND_YAHOO_NETWORK_INTERCEPTOR__";
  const MAX_BODY_LENGTH = 5_000;
  const valuationKeywords = [
    "Market Cap",
    "Enterprise Value",
    "Trailing P/E",
    "Forward P/E",
    "Price/Sales",
    "Price/Book",
    "PeRatio",
    "ForwardPeRatio",
    "MarketCap",
    "EnterpriseValue",
  ];
  const sensitiveKey = /(?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)/i;

  if (window[INSTALL_KEY]) window.YAHOO_NETWORK_STOP();

  const state = {
    originalFetch: window.fetch.bind(window),
    originalXhrOpen: XMLHttpRequest.prototype.open,
    originalXhrSend: XMLHttpRequest.prototype.send,
    originalCreateObjectURL: URL.createObjectURL.bind(URL),
    originalRevokeObjectURL: URL.revokeObjectURL.bind(URL),
  };

  const redactText = (value) => String(value)
    .replace(/((?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)\s*[=:]\s*)([^&\s,;"'}]+)/gi, "$1[REDACTED]")
    .replace(/("(?:cookie|authorization|crumb|token|api[_-]?key|session|set-cookie)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");

  const sanitizeUrl = (rawUrl) => {
    try {
      const url = new URL(rawUrl, window.location.href);
      for (const [key] of url.searchParams) {
        if (sensitiveKey.test(key)) url.searchParams.set(key, "[REDACTED]");
      }
      return url.toString();
    } catch {
      return redactText(rawUrl);
    }
  };

  const preview = (value) => redactText(value).slice(0, MAX_BODY_LENGTH);
  const containsValuationKeywords = (value) => valuationKeywords.some((keyword) => String(value).toLowerCase().includes(keyword.toLowerCase()));
  const log = (entry) => window.YAHOO_NETWORK_LOGS.push({ timestamp: new Date().toISOString(), ...entry });

  window.YAHOO_NETWORK_LOGS = [];
  window.YAHOO_NETWORK_CLEAR = () => { window.YAHOO_NETWORK_LOGS.length = 0; console.info("YAHOO NETWORK LOGS CLEARED"); };
  window.YAHOO_NETWORK_HITS = () => window.YAHOO_NETWORK_LOGS.filter((entry) => entry.containsValuationKeywords);
  window.YAHOO_NETWORK_MARK = (label = "marker") => log({ kind: "MARK", label: String(label), method: null, requestUrl: null, status: null, contentType: null, bodyPreview: "", containsValuationKeywords: false });
  window.YAHOO_NETWORK_DOWNLOAD = () => {
    const json = JSON.stringify(window.YAHOO_NETWORK_LOGS, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const href = state.originalCreateObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "yahoo-network-sanitized.json";
    anchor.click();
    setTimeout(() => state.originalRevokeObjectURL(href), 1_000);
  };

  window.fetch = async function smartfundInterceptedFetch(input, init = {}) {
    const requestUrl = sanitizeUrl(input instanceof Request ? input.url : String(input));
    const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const response = await state.originalFetch(input, init);
    let bodyPreview = "[BODY_UNAVAILABLE]";
    try { bodyPreview = preview(await response.clone().text()); } catch {}
    log({ kind: "FETCH", method, requestUrl, status: response.status, contentType: response.headers.get("content-type"), bodyPreview, containsValuationKeywords: containsValuationKeywords(bodyPreview) });
    return response;
  };

  XMLHttpRequest.prototype.open = function smartfundInterceptedOpen(method, url, ...rest) {
    this.__smartfundYahooRequest = { method: String(method).toUpperCase(), requestUrl: sanitizeUrl(String(url)) };
    return state.originalXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function smartfundInterceptedSend(...args) {
    this.addEventListener("loadend", () => {
      const meta = this.__smartfundYahooRequest || { method: "GET", requestUrl: null };
      let bodyPreview = "[BODY_UNAVAILABLE]";
      try { bodyPreview = preview(this.responseText || ""); } catch {}
      log({ kind: "XHR", ...meta, status: this.status, contentType: this.getResponseHeader("content-type"), bodyPreview, containsValuationKeywords: containsValuationKeywords(bodyPreview) });
    }, { once: true });
    return state.originalXhrSend.apply(this, args);
  };

  URL.createObjectURL = function smartfundInterceptedCreateObjectURL(blob) {
    const objectUrl = state.originalCreateObjectURL(blob);
    Promise.resolve(blob?.text?.()).then((text) => {
      const bodyPreview = preview(text || "");
      log({ kind: "BLOB", method: null, requestUrl: objectUrl, status: null, contentType: blob?.type || null, blobMimeType: blob?.type || null, blobSize: blob?.size ?? null, bodyPreview, containsValuationKeywords: containsValuationKeywords(bodyPreview) });
    }).catch(() => log({ kind: "BLOB", method: null, requestUrl: objectUrl, status: null, contentType: blob?.type || null, blobMimeType: blob?.type || null, blobSize: blob?.size ?? null, bodyPreview: "[BLOB_TEXT_UNAVAILABLE]", containsValuationKeywords: false }));
    return objectUrl;
  };

  window.YAHOO_NETWORK_STOP = () => {
    window.fetch = state.originalFetch;
    XMLHttpRequest.prototype.open = state.originalXhrOpen;
    XMLHttpRequest.prototype.send = state.originalXhrSend;
    URL.createObjectURL = state.originalCreateObjectURL;
    URL.revokeObjectURL = state.originalRevokeObjectURL;
    delete window[INSTALL_KEY];
    console.info("YAHOO NETWORK INTERCEPTOR STOPPED");
  };
  window[INSTALL_KEY] = state;
  console.info("INTERCEPTOR INSTALLED");
})();
