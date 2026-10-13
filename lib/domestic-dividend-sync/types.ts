export type SitcaDividendRow = {
  fundType: string;
  taxId: string; // 基金統編
  fundName: string;
  currency: string; // 配息幣別
  baseDate: string; // YYYY-MM-DD, 配息基準日
  exDate: string; // YYYY-MM-DD, 除息日
  payDate: string | null; // YYYY-MM-DD, 收益分配發放日
  amount: number; // 每單位分派金額
};

export type FundRow = { id: string; code: string | null; name: string; currency: string };

export type DividendMatchResult = {
  fundId: string;
  sitcaCurrency: string;
  fundCurrency: string;
  matchedBy: "CODE" | "NAME";
  row: SitcaDividendRow;
};

export type DividendMatchOutcome = {
  matched: DividendMatchResult[];
  unmatched: SitcaDividendRow[];
};
