// Shared types for the forum content filter engine.
// Config shape mirrors docs/specs/forum-filter-terms.draft.json (production config path TBD — see spec section 5).

export type FilterCategory = "fraud_redirect" | "stock_trading_advice" | "profanity";
export type FilterAction = "BLOCK" | "NOTIFY";

export interface FilterReason {
  category: FilterCategory;
  action: FilterAction;
  matched: string;
  message: string;
}

export interface FilterVerdict {
  /** BLOCK: reject the post/edit. NOTIFY: allow it through but alert the admin. ALLOW: no issue found. */
  action: "BLOCK" | "NOTIFY" | "ALLOW";
  reasons: FilterReason[];
}

export interface FraudRedirectConfig {
  action: "BLOCK";
  description: string;
  patterns: {
    phone_like: string[];
    email_like: string[];
    messaging_apps: string[];
    solicitation_terms: string[];
    private_contact_terms_blocked_outright: string[];
    notify_only_standalone_terms: string[];
  };
  whitelisted_domains: string[];
}

export interface StockTradingAdviceConfig {
  action: "CONDITIONAL_BLOCK";
  description: string;
  window_chars: number;
  trading_verbs_blocked: string[];
  data_terms_not_blocked: string[];
  notify_only_combo: string[];
}

export interface ProfanityConfig {
  action: "MIXED";
  description: string;
  block_outright: {
    personal_attack_examples: string[];
    discrimination_examples: string[];
  };
  notify_only_examples: string[];
}

export interface FilterConfig {
  version: string;
  categories: {
    fraud_redirect: FraudRedirectConfig;
    stock_trading_advice: StockTradingAdviceConfig;
    profanity: ProfanityConfig;
  };
}

/** Stock codes/names used for the trading-advice check. Real list TBD — see spec section 12. */
export interface StockDirectory {
  codes: string[];
  names: string[];
}
