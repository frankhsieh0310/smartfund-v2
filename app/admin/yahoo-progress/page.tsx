"use client";

// Internal, read-only status page for the long-running Yahoo ETF/Fund cloud ingestion sweeps.
// No start/stop/reset/re-run/delete controls exist here on purpose — this page can only ever
// display what /api/yahoo-ingestion/progress (also read-only) returns.

import { useCallback, useEffect, useState } from "react";

type SliceRow = {
  started_at: string; completed_at: string | null; status: string;
  attempted: number | null; succeeded: number | null; failed: number | null;
  runtime_ms: number | null; checkpoint_after: unknown;
};

type EtaBasis = "1H_WALLCLOCK" | "RECENT_CADENCE" | "3H_WALLCLOCK" | "STALLED" | "INSUFFICIENT_SAMPLES";
type EtaConfidence = "LOW" | "MEDIUM" | "HIGH";

type SweepSection = {
  total: number; processed: number; succeeded: number; failed: number;
  percent_complete: number; remaining: number; checkpoint_last_symbol: string | null;
  last_slice_started_at: string | null; last_slice_completed_at: string | null;
  workflow_status: "RUNNING" | "IDLE" | "STALLED" | "COMPLETED" | "ERROR";
  items_per_hour_1h: number | null; items_per_hour_3h: number | null;
  recent_slice_attempted: number | null; recent_slice_runtime_s: number | null; median_slice_runtime_s: number | null;
  eta_hours: number | null; estimated_finish_at: string | null;
  eta_basis: EtaBasis; eta_confidence: EtaConfidence;
  recent_slices: SliceRow[];
};

type FundSweepSection = Omit<SweepSection, "total"> & {
  total_discovered: number; masters_created: number;
  morningstar_success_rate: number | null; holdings_success_rate: number | null; core_success_rate: number | null;
};

type RepairSection = { total_seeded: number; resolved: number; pending: number; not_available: number; percent_complete: number; last_run_at: string | null };

type DistributionBackfillSlice = { started_at: string; completed_at: string | null; status: string; attempted: number | null; succeeded: number | null; failed: number | null; events_written: number | null; runtime_ms: number | null };
type DistributionBackfillSection = {
  total_target: number; processed: number; succeeded: number; failed: number;
  percent_complete: number; remaining: number;
  scan_progress: { processed: number; total: number };
  distribution_coverage: { etfs_with_data: number; etfs_scanned: number };
  etfs_with_distribution_data: number; distribution_rows: number;
  last_slice_started_at: string | null; last_slice_completed_at: string | null;
  workflow_status: "RUNNING" | "IDLE" | "STALLED" | "COMPLETED" | "ERROR";
  items_per_hour_1h: number | null; items_per_hour_3h: number | null;
  recent_slice_attempted: number | null; recent_slice_runtime_s: number | null; median_slice_runtime_s: number | null;
  eta_hours: number | null; estimated_finish_at: string | null;
  eta_basis: EtaBasis; eta_confidence: EtaConfidence;
  checkpoint_before: unknown; checkpoint_after: unknown;
  recent_slices: DistributionBackfillSlice[];
};

type ProgressResponse = {
  ETF_FULL_SWEEP: SweepSection;
  ETF_REPAIR: RepairSection;
  ETF_DISTRIBUTION_BACKFILL: DistributionBackfillSection;
  FUND_FULL_SWEEP: FundSweepSection;
  FUND_REPAIR: RepairSection;
  SYSTEM: { windows_required: boolean; manual_operation_required: boolean; cloud_only: boolean; last_updated_at: string };
};

const STATUS_LABEL: Record<string, string> = {
  RUNNING: "雲端執行中", IDLE: "尚未啟動", STALLED: "疑似卡住", COMPLETED: "已完成一輪", ERROR: "發生錯誤",
};
const STATUS_COLOR: Record<string, string> = {
  RUNNING: "#1d9a5f", IDLE: "#8a8f98", STALLED: "#c9932b", COMPLETED: "#2f6fed", ERROR: "#d1453b",
};

function fmtEta(hours: number | null, basis?: EtaBasis): string {
  if (basis === "STALLED") return "目前進度暫停，ETA 待恢復後重新估算";
  if (hours == null) return "資料累積中，暫無 ETA";
  if (hours < 1) return `約 ${Math.round(hours * 60)} 分鐘`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return days > 0 ? `約 ${days} 天 ${rem} 小時` : `約 ${Math.round(hours)} 小時`;
}
const ETA_BASIS_LABEL: Record<EtaBasis, string> = {
  "1H_WALLCLOCK": "依最近 1 小時實際雲端處理速度動態估算",
  "RECENT_CADENCE": "依最近成功 slice 的處理節奏動態估算",
  "3H_WALLCLOCK": "依最近 3 小時實際雲端處理速度動態估算",
  "STALLED": "進度暫停中",
  "INSUFFICIENT_SAMPLES": "資料累積中",
};
const CONFIDENCE_LABEL: Record<EtaConfidence, string> = { LOW: "低", MEDIUM: "中", HIGH: "高" };
const CONFIDENCE_COLOR: Record<EtaConfidence, string> = { LOW: "#c9932b", MEDIUM: "#2f6fed", HIGH: "#1d9a5f" };
function fmtFinishAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function n(x: number | null | undefined): string {
  return x == null ? "—" : x.toLocaleString("en-US");
}

function Bar({ pct }: { pct: number }) {
  return (
    <div style={{ background: "#e7e9ee", borderRadius: 6, height: 10, overflow: "hidden", margin: "8px 0" }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", background: "#2f6fed", transition: "width .4s" }} />
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
      color: "#fff", background: STATUS_COLOR[status] ?? "#8a8f98",
    }}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function SweepCard({ title, processed, total, pctLabel, rate3h, rate1h, recentAttempted, recentRuntimeS, medianRuntimeS, eta, finishAt, etaBasis, etaConfidence, status, extra }: {
  title: string; processed: number; total: number; pctLabel: number;
  rate3h: number | null; rate1h: number | null;
  recentAttempted: number | null; recentRuntimeS: number | null; medianRuntimeS: number | null;
  eta: number | null; finishAt: string | null;
  etaBasis: EtaBasis; etaConfidence: EtaConfidence; status: string; extra?: React.ReactNode;
}) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e5ea", borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h3>
        <StatusPill status={status} />
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>
        {n(processed)} / {n(total)}
      </div>
      <div style={{ fontSize: 13, color: "#666" }}>{pctLabel.toFixed(1)}%</div>
      <Bar pct={pctLabel} />
      <div style={{ fontSize: 13, color: "#444", display: "grid", gap: 4, marginTop: 8 }}>
        <div>最近 1 小時：{rate1h != null ? `${n(rate1h)} 檔/小時` : "資料累積中"}</div>
        <div>最近 3 小時：{rate3h != null ? `${n(rate3h)} 檔/小時` : "資料累積中"}</div>
        {recentAttempted != null && recentRuntimeS != null && <div>最近成功 slice：{n(recentAttempted)} 檔 / {recentRuntimeS} 秒</div>}
        {medianRuntimeS != null && <div>平均 slice runtime：{medianRuntimeS} 秒</div>}
        <div>{etaBasis === "STALLED" ? "目前狀態" : "預估剩餘"}：{fmtEta(eta, etaBasis)}</div>
        {eta != null && etaBasis !== "STALLED" && <div>預估完成時間：{fmtFinishAt(finishAt)}（{ETA_BASIS_LABEL[etaBasis]}）</div>}
        <div>ETA 可信度：<span style={{ color: CONFIDENCE_COLOR[etaConfidence], fontWeight: 700 }}>{CONFIDENCE_LABEL[etaConfidence]}</span></div>
        {extra}
      </div>
    </div>
  );
}

function RepairCard({ title, resolved, total, pending, notAvailable, lastRunAt }: {
  title: string; resolved: number; total: number; pending: number; notAvailable: number; lastRunAt: string | null;
}) {
  const pct = total > 0 ? (resolved / total) * 100 : 100;
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e5ea", borderRadius: 12, padding: 16 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h3>
      {total > 0 ? (
        <>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{n(resolved)} / {n(total)}</div>
          <div style={{ fontSize: 13, color: "#666" }}>{pct.toFixed(1)}%</div>
          <Bar pct={pct} />
          <div style={{ fontSize: 13, color: "#444" }}>待處理：{n(pending)}　不可用：{n(notAvailable)}</div>
        </>
      ) : (
        <div style={{ fontSize: 20, fontWeight: 700, marginTop: 10 }}>目前：0 pending</div>
      )}
      <div style={{ fontSize: 12, color: "#999", marginTop: 6 }}>最後執行：{fmtTs(lastRunAt)}</div>
    </div>
  );
}

function DistributionBackfillCard({ d }: { d: DistributionBackfillSection }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e5ea", borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>ETF 配息回補</h3>
        <StatusPill status={d.workflow_status} />
      </div>
      <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>掃描進度</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
        {n(d.scan_progress.processed)} / {n(d.scan_progress.total)}
      </div>
      <div style={{ fontSize: 13, color: "#666" }}>{d.percent_complete.toFixed(1)}%</div>
      <Bar pct={d.percent_complete} />
      <div style={{ fontSize: 13, color: "#444", display: "grid", gap: 4, marginTop: 8 }}>
        <div>已有配息資料：{n(d.etfs_with_distribution_data)} 檔（已掃描 {n(d.distribution_coverage.etfs_scanned)} 檔中）</div>
        <div>配息紀錄：{n(d.distribution_rows)} 筆</div>
        <div>最近 1 小時：{d.items_per_hour_1h != null ? `${n(d.items_per_hour_1h)} 檔/小時` : "資料累積中"}</div>
        <div>最近 3 小時：{d.items_per_hour_3h != null ? `${n(d.items_per_hour_3h)} 檔/小時` : "資料累積中"}</div>
        {d.recent_slice_attempted != null && d.recent_slice_runtime_s != null && <div>最近成功 slice：{n(d.recent_slice_attempted)} 檔 / {d.recent_slice_runtime_s} 秒</div>}
        {d.median_slice_runtime_s != null && <div>平均 slice runtime：{d.median_slice_runtime_s} 秒</div>}
        <div>{d.eta_basis === "STALLED" ? "目前狀態" : "目前 ETA"}：{fmtEta(d.eta_hours, d.eta_basis)}</div>
        {d.eta_hours != null && d.eta_basis !== "STALLED" && <div>預估完成：{fmtFinishAt(d.estimated_finish_at)}（{ETA_BASIS_LABEL[d.eta_basis]}）</div>}
        <div>ETA 可信度：<span style={{ color: CONFIDENCE_COLOR[d.eta_confidence], fontWeight: 700 }}>{CONFIDENCE_LABEL[d.eta_confidence]}</span></div>
      </div>
      <div style={{ fontSize: 11, color: "#aaa", marginTop: 8 }}>
        0 檔配息資料不代表回補失敗 — 許多 ETF（如成長型、不配息 ETF）本來就沒有配息紀錄。最後執行：{fmtTs(d.last_slice_completed_at)}
      </div>
    </div>
  );
}

function SlicesTable({ rows }: { rows: SliceRow[] }) {
  if (!rows.length) return <div style={{ color: "#888", fontSize: 13 }}>尚無紀錄</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 560 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#888" }}>
            <th style={{ padding: "4px 8px" }}>時間</th>
            <th style={{ padding: "4px 8px" }}>狀態</th>
            <th style={{ padding: "4px 8px" }}>嘗試</th>
            <th style={{ padding: "4px 8px" }}>成功</th>
            <th style={{ padding: "4px 8px" }}>失敗</th>
            <th style={{ padding: "4px 8px" }}>耗時</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid #eee" }}>
              <td style={{ padding: "4px 8px" }}>{fmtTs(r.started_at)}</td>
              <td style={{ padding: "4px 8px" }}>{r.status}</td>
              <td style={{ padding: "4px 8px" }}>{n(r.attempted)}</td>
              <td style={{ padding: "4px 8px" }}>{n(r.succeeded)}</td>
              <td style={{ padding: "4px 8px" }}>{n(r.failed)}</td>
              <td style={{ padding: "4px 8px" }}>{r.runtime_ms != null ? `${Math.round(r.runtime_ms / 1000)}s` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DistributionSlicesTable({ rows }: { rows: DistributionBackfillSlice[] }) {
  if (!rows.length) return <div style={{ color: "#888", fontSize: 13 }}>尚無紀錄</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 560 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#888" }}>
            <th style={{ padding: "4px 8px" }}>時間</th>
            <th style={{ padding: "4px 8px" }}>狀態</th>
            <th style={{ padding: "4px 8px" }}>掃描</th>
            <th style={{ padding: "4px 8px" }}>成功</th>
            <th style={{ padding: "4px 8px" }}>失敗</th>
            <th style={{ padding: "4px 8px" }}>新增配息筆數</th>
            <th style={{ padding: "4px 8px" }}>耗時</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: "1px solid #eee" }}>
              <td style={{ padding: "4px 8px" }}>{fmtTs(r.started_at)}</td>
              <td style={{ padding: "4px 8px" }}>{r.status}</td>
              <td style={{ padding: "4px 8px" }}>{n(r.attempted)}</td>
              <td style={{ padding: "4px 8px" }}>{n(r.succeeded)}</td>
              <td style={{ padding: "4px 8px" }}>{n(r.failed)}</td>
              <td style={{ padding: "4px 8px" }}>{n(r.events_written)}</td>
              <td style={{ padding: "4px 8px" }}>{r.runtime_ms != null ? `${Math.round(r.runtime_ms / 1000)}s` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function YahooProgressPage() {
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/yahoo-ingestion/progress", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000); // 60s auto-refresh — not per-second DB polling
    return () => clearInterval(id);
  }, [load]);

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 16px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1a1a1a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Yahoo ETF / Fund 匯入進度</h1>
        <button
          onClick={load}
          disabled={loading}
          style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #ccc", background: "#fff", cursor: "pointer", fontSize: 13 }}
        >
          {loading ? "更新中…" : "立即刷新"}
        </button>
      </div>
      <p style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
        唯讀狀態頁，每 60 秒自動刷新。此頁不提供啟動 / 停止 / 重置 / 重跑 / 刪除等操作。
        {data && `　最後更新：${fmtTs(data.SYSTEM.last_updated_at)}`}
      </p>

      {error && <div style={{ color: "#d1453b", marginTop: 12 }}>讀取失敗：{error}</div>}

      {data && (
        <>
          <div style={{ fontSize: 12, color: "#666", marginTop: 12, display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
            <span>ETF 全量匯入 <StatusPill status={data.ETF_FULL_SWEEP.workflow_status} /></span>
            <span>ETF Enrich Repair <StatusPill status={data.ETF_REPAIR.pending > 0 ? "RUNNING" : "COMPLETED"} /></span>
            <span>ETF 配息回補 <StatusPill status={data.ETF_DISTRIBUTION_BACKFILL.workflow_status} /></span>
            <span>Fund 全量匯入 <StatusPill status={data.FUND_FULL_SWEEP.workflow_status} /></span>
            <span>Fund Repair <StatusPill status={data.FUND_REPAIR.pending > 0 ? "RUNNING" : "COMPLETED"} /></span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginTop: 16 }}>
            <SweepCard
              title="Yahoo ETF 全量匯入"
              processed={data.ETF_FULL_SWEEP.processed} total={data.ETF_FULL_SWEEP.total}
              pctLabel={data.ETF_FULL_SWEEP.percent_complete}
              rate3h={data.ETF_FULL_SWEEP.items_per_hour_3h} rate1h={data.ETF_FULL_SWEEP.items_per_hour_1h}
              recentAttempted={data.ETF_FULL_SWEEP.recent_slice_attempted} recentRuntimeS={data.ETF_FULL_SWEEP.recent_slice_runtime_s} medianRuntimeS={data.ETF_FULL_SWEEP.median_slice_runtime_s}
              eta={data.ETF_FULL_SWEEP.eta_hours} finishAt={data.ETF_FULL_SWEEP.estimated_finish_at}
              etaBasis={data.ETF_FULL_SWEEP.eta_basis} etaConfidence={data.ETF_FULL_SWEEP.eta_confidence} status={data.ETF_FULL_SWEEP.workflow_status}
            />
            <RepairCard
              title="ETF 補修"
              resolved={data.ETF_REPAIR.resolved} total={data.ETF_REPAIR.total_seeded}
              pending={data.ETF_REPAIR.pending} notAvailable={data.ETF_REPAIR.not_available}
              lastRunAt={data.ETF_REPAIR.last_run_at}
            />
            <DistributionBackfillCard d={data.ETF_DISTRIBUTION_BACKFILL} />
            <SweepCard
              title="Yahoo 基金全量匯入"
              processed={data.FUND_FULL_SWEEP.processed} total={data.FUND_FULL_SWEEP.total_discovered}
              pctLabel={data.FUND_FULL_SWEEP.percent_complete}
              rate3h={data.FUND_FULL_SWEEP.items_per_hour_3h} rate1h={data.FUND_FULL_SWEEP.items_per_hour_1h}
              recentAttempted={data.FUND_FULL_SWEEP.recent_slice_attempted} recentRuntimeS={data.FUND_FULL_SWEEP.recent_slice_runtime_s} medianRuntimeS={data.FUND_FULL_SWEEP.median_slice_runtime_s}
              eta={data.FUND_FULL_SWEEP.eta_hours} finishAt={data.FUND_FULL_SWEEP.estimated_finish_at}
              etaBasis={data.FUND_FULL_SWEEP.eta_basis} etaConfidence={data.FUND_FULL_SWEEP.eta_confidence} status={data.FUND_FULL_SWEEP.workflow_status}
              extra={
                <div>
                  Master 數：{n(data.FUND_FULL_SWEEP.masters_created)}
                  Morningstar 成功率：{data.FUND_FULL_SWEEP.morningstar_success_rate ?? "—"}%
                  Holdings 成功率：{data.FUND_FULL_SWEEP.holdings_success_rate ?? "—"}%
                </div>
              }
            />
            <RepairCard
              title="基金補修"
              resolved={data.FUND_REPAIR.resolved} total={data.FUND_REPAIR.total_seeded}
              pending={data.FUND_REPAIR.pending} notAvailable={data.FUND_REPAIR.not_available}
              lastRunAt={data.FUND_REPAIR.last_run_at}
            />
          </div>

          <h2 style={{ fontSize: 15, marginTop: 24 }}>ETF 最近 10 次執行</h2>
          <SlicesTable rows={data.ETF_FULL_SWEEP.recent_slices} />

          <h2 style={{ fontSize: 15, marginTop: 20 }}>ETF 配息回補最近 10 次執行</h2>
          <DistributionSlicesTable rows={data.ETF_DISTRIBUTION_BACKFILL.recent_slices} />

          <h2 style={{ fontSize: 15, marginTop: 20 }}>基金最近 10 次執行</h2>
          <SlicesTable rows={data.FUND_FULL_SWEEP.recent_slices} />

          <p style={{ fontSize: 11, color: "#aaa", marginTop: 24 }}>
            cloud-only：不依賴 Windows，不需要手動更新（windows_required={String(data.SYSTEM.windows_required)}，
            manual_operation_required={String(data.SYSTEM.manual_operation_required)}）。
          </p>
        </>
      )}
    </div>
  );
}
