export type FundclearDistributionRecord = {
  baseDate: string; // YYYY-MM-DD, 配息基準日
  exDate: string; // YYYY-MM-DD, 除息日
  payDate: string | null; // YYYY-MM-DD, 配息發放日
  amount: number; // 每單位分派金額（原幣別，稅後）
  frequency: string | null; // e.g. "每月"
  incomeRatioPct: number | null; // 可分配淨利益 % (0-100)
  returnOfCapitalRatioPct: number | null; // 本金 % (0-100)
};

export type FundclearFundDistributions = {
  currency: string; // from query-simple-data's currencyName
  fundName: string;
  records: FundclearDistributionRecord[];
};

export type DistributionCandidate = {
  fundId: string;
  code: string;
};
