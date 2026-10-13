import type {
  FilterConfig,
  FilterReason,
  StockDirectory,
} from "./types.ts";
import { normalizeForLinks, normalizeText } from "./normalize.ts";

const TW_PHONE_PATTERN = /09\d{8}/;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;
// Bare domains (official sites excluded via the whitelist) and known shortlink hosts.
const URL_PATTERN = /(https?:\/\/[^\s]+)|(\b[a-z0-9-]+\.(com|net|tw|cc|me|io|ly)\b\/?[^\s]*)/;
const SHORTLINK_HOSTS = ["bit.ly", "reurl.cc", "lihi.cc", "tinyurl.com", "is.gd", "cutt.ly"];

function extractDomain(match: string): string {
  const withoutProtocol = match.replace(/^https?:\/\//, "");
  return withoutProtocol.split(/[/?#]/)[0]!.toLowerCase();
}

export function checkFraudRedirect(
  rawText: string,
  config: FilterConfig["categories"]["fraud_redirect"],
): FilterReason[] {
  const reasons: FilterReason[] = [];
  const normalized = normalizeText(rawText);
  const forLinks = normalizeForLinks(rawText);

  if (TW_PHONE_PATTERN.test(normalized)) {
    reasons.push({
      category: "fraud_redirect",
      action: "BLOCK",
      matched: "phone_like",
      message: "偵測到電話號碼格式，可能是導流聯絡方式，已擋下發文。",
    });
  }

  if (EMAIL_PATTERN.test(forLinks)) {
    reasons.push({
      category: "fraud_redirect",
      action: "BLOCK",
      matched: "email_like",
      message: "偵測到 Email 格式，可能是導流聯絡方式，已擋下發文。",
    });
  }

  for (const app of config.patterns.messaging_apps) {
    if (normalized.includes(app.toLowerCase())) {
      reasons.push({
        category: "fraud_redirect",
        action: "BLOCK",
        matched: app,
        message: `偵測到通訊軟體名稱「${app}」，可能是導流聯絡方式，已擋下發文。`,
      });
    }
  }

  const urlMatch = forLinks.match(URL_PATTERN);
  if (urlMatch) {
    const domain = extractDomain(urlMatch[0]);
    const whitelisted = config.whitelisted_domains.some(
      (allowed) => domain === allowed.toLowerCase() || domain.endsWith(`.${allowed.toLowerCase()}`),
    );
    const isShortlink = SHORTLINK_HOSTS.some((host) => domain === host || domain.endsWith(`.${host}`));
    if (!whitelisted || isShortlink) {
      reasons.push({
        category: "fraud_redirect",
        action: "BLOCK",
        matched: domain,
        message: `偵測到外部連結「${domain}」，非白名單網域，已擋下發文。`,
      });
    }
  }

  for (const term of config.patterns.solicitation_terms) {
    if (normalized.includes(term.toLowerCase())) {
      reasons.push({
        category: "fraud_redirect",
        action: "BLOCK",
        matched: term,
        message: `偵測到招攬用語「${term}」，已擋下發文。`,
      });
    }
  }

  for (const term of config.patterns.private_contact_terms_blocked_outright) {
    if (normalized.includes(term.toLowerCase())) {
      reasons.push({
        category: "fraud_redirect",
        action: "BLOCK",
        matched: term,
        message: `偵測到私下聯絡用語「${term}」，討論區不開放私訊，已擋下發文。`,
      });
    }
  }

  for (const term of config.patterns.notify_only_standalone_terms) {
    if (normalized.includes(term.toLowerCase())) {
      reasons.push({
        category: "fraud_redirect",
        action: "NOTIFY",
        matched: term,
        message: `偵測到可能需留意的用語「${term}」，已通知管理員，文章仍可發出。`,
      });
    }
  }

  return reasons;
}

export function checkStockTradingAdvice(
  rawText: string,
  config: FilterConfig["categories"]["stock_trading_advice"],
  directory: StockDirectory,
): FilterReason[] {
  const reasons: FilterReason[] = [];
  const normalized = normalizeText(rawText);
  const window = config.window_chars;

  const identifiers = [...directory.codes, ...directory.names].map((s) => s.toLowerCase());
  const tradingVerbs = config.trading_verbs_blocked.map((s) => s.toLowerCase());
  const notifyCombos = config.notify_only_combo.map((s) => s.toLowerCase());

  for (const identifier of identifiers) {
    let searchFrom = 0;
    let idIndex = normalized.indexOf(identifier, searchFrom);
    while (idIndex !== -1) {
      const windowStart = Math.max(0, idIndex - window);
      const windowEnd = Math.min(normalized.length, idIndex + identifier.length + window);
      const context = normalized.slice(windowStart, windowEnd);

      const matchedVerb = tradingVerbs.find((verb) => context.includes(verb));
      if (matchedVerb) {
        reasons.push({
          category: "stock_trading_advice",
          action: "BLOCK",
          matched: `${identifier}+${matchedVerb}`,
          message: `偵測到個股代號/名稱「${identifier}」與交易用語「${matchedVerb}」出現在 ${window} 字範圍內，可能構成交易建議，已擋下發文。`,
        });
      } else {
        const matchedCombo = notifyCombos.find((combo) => {
          const [, verbPart] = combo.split("+");
          return verbPart ? context.includes(verbPart) : false;
        });
        if (matchedCombo) {
          reasons.push({
            category: "stock_trading_advice",
            action: "NOTIFY",
            matched: `${identifier}+${matchedCombo}`,
            message: `偵測到個股代號/名稱搭配「${matchedCombo}」，已通知管理員留意，文章仍可發出。`,
          });
        }
      }

      searchFrom = idIndex + identifier.length;
      idIndex = normalized.indexOf(identifier, searchFrom);
    }
  }

  return reasons;
}

export function checkProfanity(
  rawText: string,
  config: FilterConfig["categories"]["profanity"],
): FilterReason[] {
  const reasons: FilterReason[] = [];
  const normalized = normalizeText(rawText);

  const blockedTerms = [
    ...config.block_outright.personal_attack_examples,
    ...config.block_outright.discrimination_examples,
  ];
  for (const term of blockedTerms) {
    if (term.startsWith("(")) continue; // placeholder/explanatory entries, not real terms
    if (normalized.includes(term.toLowerCase())) {
      reasons.push({
        category: "profanity",
        action: "BLOCK",
        matched: term,
        message: `偵測到人身攻擊或歧視性用語「${term}」，已擋下發文。`,
      });
    }
  }

  for (const term of config.notify_only_examples) {
    if (normalized.includes(term.toLowerCase())) {
      reasons.push({
        category: "profanity",
        action: "NOTIFY",
        matched: term,
        message: `偵測到口語用詞「${term}」，已通知管理員留意，文章仍可發出。`,
      });
    }
  }

  return reasons;
}

export function runAllRules(
  rawText: string,
  config: FilterConfig,
  directory: StockDirectory,
): FilterReason[] {
  return [
    ...checkFraudRedirect(rawText, config.categories.fraud_redirect),
    ...checkStockTradingAdvice(rawText, config.categories.stock_trading_advice, directory),
    ...checkProfanity(rawText, config.categories.profanity),
  ];
}
