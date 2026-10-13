// Task (offshore NAV auto-sync): only funds from the 962-fund tdcc-offshore Yahoo mapping sweep
// (Task Z/R item 2) that were EXACT name matches AND had no currency/class inconsistency flag are
// eligible here -- anything flagged "有疑慮" is permanently excluded from this pipeline, never guessed.
export type OffshoreMappingEntry = {
  fundId: string;
  code: string;
  yahooFundId: string;
};

export type OffshoreNavCandidate = {
  fundId: string;
  navDate: string; // YYYY-MM-DD
  nav: number;
};
