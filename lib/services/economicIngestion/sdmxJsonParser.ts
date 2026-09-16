// lib/services/economicIngestion/sdmxJsonParser.ts
//
// 通用 SDMX-JSON 解析工具。SDMX 是 UN/IMF/World Bank/BIS/ECB/OECD/
// Eurostat 共用的統計資料交換標準，這個 Parser 一次寫對，未來接
// ECB/BIS/Eurostat 都可以直接重用，不用每個 Provider 各寫一份。
//
// 依據（三個獨立來源互相印證，不是單一來源的猜測）：
//   - OECD 官方 SDMX-JSON 技術文件（data.oecd.org/api/sdmx-json-documentation）
//   - UNICEF SDMX API 文件（data.unicef.org/sdmx-api-documentation）
//   - 社群 Python 教學範例（medium.com，實際展示過解析程式碼）
//
// 核心結構：
//   response.dataSets[0].observations = {
//     "0:0:0:1": [value, ...attributes],   // key 是「維度索引」組合
//     ...
//   }
//   response.structure.dimensions.observation = [
//     { id: "REF_AREA", values: [{ id: "USA", name: "United States" }, ...] },
//     { id: "TIME_PERIOD", values: [{ id: "2025-01", name: "..." }, ...] },
//     ...
//   ]
// key "0:0:0:1" 的每一段數字，是對應同一個位置的 dimension 底下
// values 陣列的索引——例如第一段的 0，代表第一個 dimension 的
// values[0]。

export interface SdmxDimensionValue {
    id: string;
    name?: string;
  }
  
  export interface SdmxDimension {
    id: string;
    name?: string;
    values: SdmxDimensionValue[];
  }
  
  // 修正（實際看到 OECD 回傳的原始內容後確認）：OECD 用的是
  // SDMX-JSON 2.0.0 格式，整個 dataSets/structure 外面多包了一層
  // "data"（旁邊還有一個 "meta" 欄位）——不是舊版文件描述的
  // dataSets/structure 直接在頂層。這裡的型別定義要對應真實結構，
  // 不是理論上的 SDMX-JSON 1.0 結構。
  // 修正（這次接 ECB 時發現）：SDMX-JSON 有不只一種版本外殼。
  // OECD 用 2.0.0，dataSets/structure 包在一層 "data" 底下；
  // ECB 官方文件明確寫 version=1.0.0-wd，dataSets/structure 直接在
  // 頂層，沒有 "data" 包裝——兩個機構用的版本不一樣，型別要同時
  // 支援兩種，不能只認一種格式，否則每個新 Provider 都要重新踩一次
  // 「外殼對不對」的坑。
  export interface SdmxJsonResponse {
    meta?: unknown;
    // 2.0.0 格式（例如 OECD）：包在 data 底下。
    data?: {
      dataSets: Array<{ structure?: number; observations: Record<string, (number | null)[]> }>;
      structure?: { dimensions: { observation: SdmxDimension[] } };
      structures?: Record<string, { dimensions: { observation: SdmxDimension[] } }>;
    };
    // 1.0.0-wd 格式（例如 ECB）：直接在頂層。
    dataSets?: Array<{ observations: Record<string, (number | null)[]> }>;
    structure?: { dimensions: { observation: SdmxDimension[] } };
  }
  
  export interface SdmxObservation {
    // key 是 dimension id（例如 "REF_AREA"、"TIME_PERIOD"），value 是
    // 這筆觀測值對應的 dimension value id（例如 "USA"、"2025-01"）。
    dimensions: Record<string, string>;
    value: number | null;
  }
  
  // 把整包 SDMX-JSON 回應，攤平成一組好用的觀測值陣列。這個函式不知道
  // 「REF_AREA 是國家」「TIME_PERIOD 是時間」這種語意，只負責正確解碼
  // index → 實際維度值，語意判斷留給呼叫端（各個 Provider 的 Adapter）。
  export function parseSdmxJsonObservations(json: SdmxJsonResponse): SdmxObservation[] {
    // 自動偵測：有 json.data 就是 2.0.0 包裝格式，沒有就是 1.0.0-wd
    // 直接在頂層的格式。兩種都支援，呼叫端不用知道差異。
    const currentDataSet = json.data?.dataSets?.[0];
    const dataSet = currentDataSet ?? json.dataSets?.[0];
    const structuredDimensions = json.data && currentDataSet?.structure !== undefined
      ? json.data.structures?.[String(currentDataSet.structure)]?.dimensions?.observation
      : undefined;
    const dims = json.data?.structure?.dimensions?.observation
      ?? structuredDimensions
      ?? json.structure?.dimensions?.observation
      ?? [];
    const observations = dataSet?.observations ?? {};
  
    const results: SdmxObservation[] = [];
  
    for (const [key, obsArray] of Object.entries(observations)) {
      const indices = key.split(":").map((s) => parseInt(s, 10));
      const dimensionValues: Record<string, string> = {};
  
      indices.forEach((idx, position) => {
        const dim = dims[position];
        if (!dim) return;
        const val = dim.values[idx];
        if (val) dimensionValues[dim.id] = val.id;
      });
  
      const value = Array.isArray(obsArray) ? obsArray[0] : null;
      results.push({ dimensions: dimensionValues, value: value ?? null });
    }
  
    return results;
  }
