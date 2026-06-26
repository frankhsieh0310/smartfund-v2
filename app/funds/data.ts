// 基金示意資料，非即時淨值。正式上線前請替換為實際基金資料源。

export type Fund = {
    id: string;
    company: string;
    name: string;
    category: string;        // 股票型 / 債券型 / 平衡型 / 貨幣型
    region: string;
    morningstar: number;     // 晨星評等 1~5（顯示金色星星）
    dividendPerUnit: number;
    dividendFreq: string;
    dividendYieldM: number;
    dividendYieldA: number;
    returnYTD: number;
    return1m: number;
    return3m: number;
    return6m: number;
    return1y: number;
    return3y: number;
    volatility: number;
  };
  
  function fundFreq(dividendYield: number): string {
    if (dividendYield === 0) return "不配息";
    return "月配";
  }
  
  const RAW_FUNDS: Array<{
    id: string; company: string; name: string; category: string; region: string;
    dividendYield: number; return1m: number; return3m: number; return6m: number;
    return1y: number; return3y: number; volatility: number; morningstar: number;
  }> = [
    // ---- 野村 ----
    { id:"NOM-001", company:"野村", name:"野村全球優質基金",       category:"股票型", region:"全球",   dividendYield:0,   return1m:2.1, return3m:6.4,  return6m:11.2, return1y:18.4, return3y:12.1, volatility:12.8, morningstar:4 },
    { id:"NOM-002", company:"野村", name:"野村台灣基金",           category:"股票型", region:"台灣",   dividendYield:2.8, return1m:1.8, return3m:5.2,  return6m:9.8,  return1y:21.6, return3y:14.2, volatility:15.2, morningstar:4 },
    { id:"NOM-003", company:"野村", name:"野村亞太高股息基金",     category:"股票型", region:"亞洲",   dividendYield:5.2, return1m:1.2, return3m:3.8,  return6m:7.4,  return1y:12.8, return3y:8.4,  volatility:11.4, morningstar:3 },
    { id:"NOM-004", company:"野村", name:"野村全球債券基金",       category:"債券型", region:"全球",   dividendYield:4.8, return1m:0.4, return3m:1.2,  return6m:2.8,  return1y:5.4,  return3y:3.2,  volatility:5.2,  morningstar:3 },
    { id:"NOM-005", company:"野村", name:"野村平衡基金",           category:"平衡型", region:"全球",   dividendYield:0,   return1m:1.4, return3m:4.2,  return6m:7.8,  return1y:13.2, return3y:8.8,  volatility:9.8,  morningstar:3 },
    { id:"NOM-006", company:"野村", name:"野村AI人工智能基金",     category:"股票型", region:"全球",   dividendYield:0,   return1m:2.8, return3m:8.4,  return6m:16.2, return1y:28.4, return3y:14.8, volatility:20.8, morningstar:4 },
    { id:"NOM-007", company:"野村", name:"野村中國機會基金",       category:"股票型", region:"中國",   dividendYield:0,   return1m:1.2, return3m:3.6,  return6m:7.2,  return1y:12.4, return3y:7.8,  volatility:18.4, morningstar:3 },
    { id:"NOM-008", company:"野村", name:"野村印度基金",           category:"股票型", region:"印度",   dividendYield:0,   return1m:2.0, return3m:6.0,  return6m:11.4, return1y:19.8, return3y:13.2, volatility:21.2, morningstar:4 },
    { id:"NOM-009", company:"野村", name:"野村美國高收益債基金",   category:"債券型", region:"美國",   dividendYield:7.2, return1m:0.9, return3m:2.6,  return6m:5.2,  return1y:8.8,  return3y:5.8,  volatility:7.8,  morningstar:3 },
    { id:"NOM-010", company:"野村", name:"野村歐洲高股息基金",     category:"股票型", region:"歐洲",   dividendYield:4.4, return1m:1.4, return3m:4.2,  return6m:8.4,  return1y:14.2, return3y:9.4,  volatility:12.4, morningstar:3 },
    { id:"NOM-011", company:"野村", name:"野村全球不動產基金",     category:"股票型", region:"全球",   dividendYield:4.8, return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.2, return3y:6.8,  volatility:11.8, morningstar:3 },
    { id:"NOM-012", company:"野村", name:"野村新興亞洲股票基金",   category:"股票型", region:"亞洲",   dividendYield:0,   return1m:1.6, return3m:4.8,  return6m:9.2,  return1y:15.8, return3y:9.8,  volatility:16.8, morningstar:3 },
    { id:"NOM-013", company:"野村", name:"野村貨幣市場基金",       category:"貨幣型", region:"台灣",   dividendYield:1.8, return1m:0.1, return3m:0.4,  return6m:0.8,  return1y:1.8,  return3y:1.6,  volatility:0.4,  morningstar:3 },
    { id:"NOM-014", company:"野村", name:"野村短期優質債基金",     category:"債券型", region:"美國",   dividendYield:4.2, return1m:0.3, return3m:1.0,  return6m:2.0,  return1y:4.2,  return3y:2.8,  volatility:3.2,  morningstar:3 },
    { id:"NOM-015", company:"野村", name:"野村全球科技基金",       category:"股票型", region:"全球",   dividendYield:0,   return1m:3.2, return3m:9.6,  return6m:18.4, return1y:30.2, return3y:18.4, volatility:20.4, morningstar:4 },
    // ---- 富邦 ----
    { id:"FTB-001", company:"富邦", name:"富邦科技基金",           category:"股票型", region:"全球",   dividendYield:0,   return1m:3.2, return3m:9.8,  return6m:18.4, return1y:32.4, return3y:22.1, volatility:22.4, morningstar:5 },
    { id:"FTB-002", company:"富邦", name:"富邦台灣優質基金",       category:"股票型", region:"台灣",   dividendYield:3.2, return1m:2.0, return3m:5.8,  return6m:10.4, return1y:22.8, return3y:15.4, volatility:14.8, morningstar:4 },
    { id:"FTB-003", company:"富邦", name:"富邦全球高收益債基金",   category:"債券型", region:"全球",   dividendYield:6.8, return1m:0.8, return3m:2.4,  return6m:4.8,  return1y:8.4,  return3y:5.8,  volatility:7.2,  morningstar:4 },
    { id:"FTB-004", company:"富邦", name:"富邦新興市場基金",       category:"股票型", region:"新興市場",dividendYield:0,  return1m:1.4, return3m:4.2,  return6m:8.2,  return1y:14.8, return3y:9.2,  volatility:16.8, morningstar:3 },
    { id:"FTB-005", company:"富邦", name:"富邦AI人工智能基金",     category:"股票型", region:"全球",   dividendYield:0,   return1m:3.0, return3m:9.0,  return6m:17.2, return1y:28.8, return3y:16.8, volatility:21.4, morningstar:4 },
    { id:"FTB-006", company:"富邦", name:"富邦印度基金",           category:"股票型", region:"印度",   dividendYield:0,   return1m:2.2, return3m:6.6,  return6m:12.4, return1y:20.4, return3y:13.8, volatility:22.4, morningstar:4 },
    { id:"FTB-007", company:"富邦", name:"富邦全球平衡基金",       category:"平衡型", region:"全球",   dividendYield:0,   return1m:1.4, return3m:4.2,  return6m:8.0,  return1y:13.8, return3y:9.2,  volatility:9.8,  morningstar:3 },
    { id:"FTB-008", company:"富邦", name:"富邦亞洲高收益債基金",   category:"債券型", region:"亞洲",   dividendYield:6.8, return1m:0.8, return3m:2.4,  return6m:4.8,  return1y:8.4,  return3y:5.6,  volatility:7.4,  morningstar:4 },
    { id:"FTB-009", company:"富邦", name:"富邦美國成長基金",       category:"股票型", region:"美國",   dividendYield:0,   return1m:2.6, return3m:7.8,  return6m:14.8, return1y:24.2, return3y:15.8, volatility:16.8, morningstar:4 },
    { id:"FTB-010", company:"富邦", name:"富邦中國機會基金",       category:"股票型", region:"中國",   dividendYield:0,   return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.8, return3y:6.8,  volatility:19.4, morningstar:3 },
    { id:"FTB-011", company:"富邦", name:"富邦日本基金",           category:"股票型", region:"日本",   dividendYield:0,   return1m:1.8, return3m:5.4,  return6m:10.2, return1y:17.6, return3y:11.4, volatility:15.8, morningstar:3 },
    { id:"FTB-012", company:"富邦", name:"富邦多重資產收益基金",   category:"平衡型", region:"全球",   dividendYield:5.8, return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.2, return3y:6.8,  volatility:8.8,  morningstar:4 },
    { id:"FTB-013", company:"富邦", name:"富邦台灣價值基金",       category:"股票型", region:"台灣",   dividendYield:3.4, return1m:1.6, return3m:4.8,  return6m:9.2,  return1y:17.4, return3y:11.4, volatility:13.2, morningstar:3 },
    { id:"FTB-014", company:"富邦", name:"富邦歐洲基金",           category:"股票型", region:"歐洲",   dividendYield:0,   return1m:1.6, return3m:4.8,  return6m:9.2,  return1y:15.8, return3y:10.4, volatility:14.4, morningstar:3 },
    // ---- 國泰 ----
    { id:"KTH-001", company:"國泰", name:"國泰全球優化高股息基金", category:"股票型", region:"全球",   dividendYield:6.4, return1m:1.6, return3m:4.8,  return6m:9.2,  return1y:15.8, return3y:10.4, volatility:10.8, morningstar:4 },
    { id:"KTH-002", company:"國泰", name:"國泰科技生技基金",       category:"股票型", region:"全球",   dividendYield:0,   return1m:2.8, return3m:8.4,  return6m:15.8, return1y:26.4, return3y:18.2, volatility:19.4, morningstar:4 },
    { id:"KTH-003", company:"國泰", name:"國泰台灣Smart基金",      category:"股票型", region:"台灣",   dividendYield:4.8, return1m:1.9, return3m:5.6,  return6m:10.8, return1y:20.4, return3y:13.8, volatility:13.8, morningstar:4 },
    { id:"KTH-004", company:"國泰", name:"國泰全球債券基金",       category:"債券型", region:"全球",   dividendYield:4.2, return1m:0.3, return3m:1.0,  return6m:2.4,  return1y:4.8,  return3y:3.0,  volatility:4.8,  morningstar:3 },
    { id:"KTH-005", company:"國泰", name:"國泰AI科技基金",         category:"股票型", region:"全球",   dividendYield:0,   return1m:3.2, return3m:9.6,  return6m:18.4, return1y:30.8, return3y:18.8, volatility:21.2, morningstar:5 },
    { id:"KTH-006", company:"國泰", name:"國泰印度優質基金",       category:"股票型", region:"印度",   dividendYield:0,   return1m:2.0, return3m:6.0,  return6m:11.4, return1y:19.4, return3y:13.0, volatility:21.8, morningstar:3 },
    { id:"KTH-007", company:"國泰", name:"國泰中國消費基金",       category:"股票型", region:"中國",   dividendYield:0,   return1m:1.2, return3m:3.6,  return6m:7.2,  return1y:12.4, return3y:7.8,  volatility:18.8, morningstar:3 },
    { id:"KTH-008", company:"國泰", name:"國泰多元收益平衡基金",   category:"平衡型", region:"全球",   dividendYield:5.4, return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.4, return3y:7.0,  volatility:8.4,  morningstar:4 },
    { id:"KTH-009", company:"國泰", name:"國泰亞太入息基金",       category:"股票型", region:"亞洲",   dividendYield:4.8, return1m:1.4, return3m:4.2,  return6m:8.4,  return1y:14.2, return3y:9.4,  volatility:13.4, morningstar:3 },
    { id:"KTH-010", company:"國泰", name:"國泰美國成長基金",       category:"股票型", region:"美國",   dividendYield:0,   return1m:2.8, return3m:8.4,  return6m:15.8, return1y:25.4, return3y:16.4, volatility:17.2, morningstar:4 },
    { id:"KTH-011", company:"國泰", name:"國泰歐洲機會基金",       category:"股票型", region:"歐洲",   dividendYield:0,   return1m:1.6, return3m:4.8,  return6m:9.2,  return1y:15.4, return3y:10.2, volatility:14.2, morningstar:3 },
    { id:"KTH-012", company:"國泰", name:"國泰短期票券基金",       category:"貨幣型", region:"台灣",   dividendYield:1.9, return1m:0.1, return3m:0.4,  return6m:0.8,  return1y:1.9,  return3y:1.7,  volatility:0.5,  morningstar:3 },
    { id:"KTH-013", company:"國泰", name:"國泰新興市場債基金",     category:"債券型", region:"新興市場",dividendYield:5.8, return1m:0.6, return3m:1.8,  return6m:3.6,  return1y:6.8,  return3y:4.4,  volatility:7.8,  morningstar:3 },
    { id:"KTH-014", company:"國泰", name:"國泰全球高收益債基金",   category:"債券型", region:"全球",   dividendYield:7.2, return1m:0.9, return3m:2.8,  return6m:5.4,  return1y:9.2,  return3y:6.4,  volatility:8.4,  morningstar:4 },
    // ---- 元大 ----
    { id:"YGT-001", company:"元大", name:"元大多元收益組合基金",   category:"平衡型", region:"全球",   dividendYield:5.6, return1m:1.1, return3m:3.4,  return6m:6.8,  return1y:11.4, return3y:7.8,  volatility:8.4,  morningstar:4 },
    { id:"YGT-002", company:"元大", name:"元大台灣深耕基金",       category:"股票型", region:"台灣",   dividendYield:0,   return1m:2.2, return3m:6.6,  return6m:12.4, return1y:23.8, return3y:16.2, volatility:15.8, morningstar:4 },
    { id:"YGT-003", company:"元大", name:"元大高科技基金",         category:"股票型", region:"台灣",   dividendYield:0,   return1m:3.4, return3m:10.2, return6m:19.6, return1y:34.8, return3y:24.4, volatility:24.2, morningstar:5 },
    { id:"YGT-004", company:"元大", name:"元大印度基金",           category:"股票型", region:"印度",   dividendYield:0,   return1m:1.8, return3m:5.4,  return6m:10.2, return1y:18.9, return3y:12.4, volatility:21.8, morningstar:3 },
    { id:"YGT-005", company:"元大", name:"元大全球AI基金",         category:"股票型", region:"全球",   dividendYield:0,   return1m:3.4, return3m:10.2, return6m:19.6, return1y:32.4, return3y:20.8, volatility:22.8, morningstar:4 },
    { id:"YGT-006", company:"元大", name:"元大亞太新興基金",       category:"股票型", region:"新興市場",dividendYield:0,  return1m:1.4, return3m:4.2,  return6m:8.0,  return1y:13.8, return3y:8.4,  volatility:17.4, morningstar:3 },
    { id:"YGT-007", company:"元大", name:"元大全球健康生技基金",   category:"股票型", region:"全球",   dividendYield:0,   return1m:1.6, return3m:4.8,  return6m:9.2,  return1y:15.4, return3y:10.2, volatility:16.4, morningstar:3 },
    { id:"YGT-008", company:"元大", name:"元大中國基金",           category:"股票型", region:"中國",   dividendYield:0,   return1m:1.2, return3m:3.6,  return6m:7.2,  return1y:12.4, return3y:7.8,  volatility:18.4, morningstar:3 },
    { id:"YGT-009", company:"元大", name:"元大全球公司債基金",     category:"債券型", region:"全球",   dividendYield:4.4, return1m:0.4, return3m:1.2,  return6m:2.4,  return1y:4.8,  return3y:3.2,  volatility:5.2,  morningstar:3 },
    { id:"YGT-010", company:"元大", name:"元大日本基金",           category:"股票型", region:"日本",   dividendYield:0,   return1m:1.8, return3m:5.4,  return6m:10.2, return1y:17.6, return3y:11.4, volatility:14.8, morningstar:3 },
    { id:"YGT-011", company:"元大", name:"元大多元資產平衡基金",   category:"平衡型", region:"全球",   dividendYield:5.2, return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.4, return3y:7.0,  volatility:8.8,  morningstar:3 },
    { id:"YGT-012", company:"元大", name:"元大美國多重資產基金",   category:"平衡型", region:"美國",   dividendYield:5.6, return1m:1.2, return3m:3.6,  return6m:7.2,  return1y:12.4, return3y:8.2,  volatility:9.2,  morningstar:4 },
    { id:"YGT-013", company:"元大", name:"元大新興市場高息基金",   category:"股票型", region:"新興市場",dividendYield:4.8, return1m:1.2, return3m:3.6,  return6m:7.2,  return1y:11.8, return3y:7.4,  volatility:16.8, morningstar:3 },
    { id:"YGT-014", company:"元大", name:"元大貨幣市場基金",       category:"貨幣型", region:"台灣",   dividendYield:1.9, return1m:0.1, return3m:0.4,  return6m:0.8,  return1y:1.9,  return3y:1.7,  volatility:0.4,  morningstar:3 },
    // ---- 安聯 ----
    { id:"ALZ-001", company:"安聯", name:"安聯台灣科技基金",       category:"股票型", region:"台灣",   dividendYield:0,   return1m:3.1, return3m:9.4,  return6m:17.8, return1y:30.2, return3y:21.4, volatility:21.2, morningstar:5 },
    { id:"ALZ-002", company:"安聯", name:"安聯收益成長基金",       category:"平衡型", region:"全球",   dividendYield:6.2, return1m:1.2, return3m:3.6,  return6m:7.2,  return1y:12.4, return3y:8.6,  volatility:9.2,  morningstar:4 },
    { id:"ALZ-003", company:"安聯", name:"安聯全球債券基金",       category:"債券型", region:"全球",   dividendYield:4.8, return1m:0.4, return3m:1.2,  return6m:2.6,  return1y:5.4,  return3y:3.2,  volatility:5.8,  morningstar:3 },
    { id:"ALZ-004", company:"安聯", name:"安聯歐洲高股息基金",     category:"股票型", region:"歐洲",   dividendYield:4.4, return1m:1.4, return3m:4.2,  return6m:8.4,  return1y:14.2, return3y:9.4,  volatility:12.4, morningstar:3 },
    { id:"ALZ-005", company:"安聯", name:"安聯AI科技基金",         category:"股票型", region:"全球",   dividendYield:0,   return1m:3.4, return3m:10.2, return6m:19.4, return1y:32.0, return3y:20.4, volatility:22.4, morningstar:5 },
    { id:"ALZ-006", company:"安聯", name:"安聯印度成長基金",       category:"股票型", region:"印度",   dividendYield:0,   return1m:2.2, return3m:6.6,  return6m:12.4, return1y:20.8, return3y:13.8, volatility:22.8, morningstar:4 },
    { id:"ALZ-007", company:"安聯", name:"安聯中國股票基金",       category:"股票型", region:"中國",   dividendYield:0,   return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.4, return3y:6.8,  volatility:19.2, morningstar:3 },
    { id:"ALZ-008", company:"安聯", name:"安聯美國非投資級債基金", category:"債券型", region:"美國",   dividendYield:7.4, return1m:1.0, return3m:3.0,  return6m:5.8,  return1y:9.8,  return3y:6.8,  volatility:8.8,  morningstar:4 },
    { id:"ALZ-009", company:"安聯", name:"安聯新興市場股票基金",   category:"股票型", region:"新興市場",dividendYield:0,  return1m:1.4, return3m:4.2,  return6m:8.0,  return1y:13.4, return3y:8.4,  volatility:17.8, morningstar:3 },
    { id:"ALZ-010", company:"安聯", name:"安聯台灣優質基金",       category:"股票型", region:"台灣",   dividendYield:0,   return1m:2.0, return3m:6.0,  return6m:11.4, return1y:20.4, return3y:13.8, volatility:14.8, morningstar:3 },
    { id:"ALZ-011", company:"安聯", name:"安聯多元收益基金",       category:"平衡型", region:"全球",   dividendYield:5.8, return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.4, return3y:7.0,  volatility:8.6,  morningstar:4 },
    { id:"ALZ-012", company:"安聯", name:"安聯美國短期投資級債基金",category:"債券型",region:"美國",   dividendYield:4.4, return1m:0.3, return3m:1.0,  return6m:2.0,  return1y:4.4,  return3y:2.8,  volatility:3.8,  morningstar:3 },
    { id:"ALZ-013", company:"安聯", name:"安聯日本基金",           category:"股票型", region:"日本",   dividendYield:0,   return1m:1.8, return3m:5.4,  return6m:10.2, return1y:17.4, return3y:11.2, volatility:15.4, morningstar:3 },
    { id:"ALZ-014", company:"安聯", name:"安聯東南亞基金",         category:"股票型", region:"亞洲",   dividendYield:0,   return1m:1.4, return3m:4.2,  return6m:8.0,  return1y:13.4, return3y:8.4,  volatility:17.2, morningstar:3 },
    // ---- 聯博 ----
    { id:"AB-001",  company:"聯博", name:"聯博科技基金",           category:"股票型", region:"美國",   dividendYield:0,   return1m:3.8, return3m:11.4, return6m:21.2, return1y:32.4, return3y:18.6, volatility:22.4, morningstar:5 },
    { id:"AB-002",  company:"聯博", name:"聯博收益債券基金",       category:"債券型", region:"全球",   dividendYield:6.1, return1m:0.7, return3m:2.1,  return6m:4.2,  return1y:7.1,  return3y:4.8,  volatility:5.1,  morningstar:4 },
    { id:"AB-003",  company:"聯博", name:"聯博全球高收益債基金",   category:"債券型", region:"全球",   dividendYield:7.2, return1m:0.9, return3m:2.8,  return6m:5.4,  return1y:9.2,  return3y:6.4,  volatility:7.8,  morningstar:4 },
    { id:"AB-004",  company:"聯博", name:"聯博美國成長基金",       category:"股票型", region:"美國",   dividendYield:0,   return1m:2.8, return3m:8.4,  return6m:15.8, return1y:24.2, return3y:15.8, volatility:16.8, morningstar:4 },
    { id:"AB-005",  company:"聯博", name:"聯博新興市場股票基金",   category:"股票型", region:"新興市場",dividendYield:0,  return1m:1.6, return3m:4.8,  return6m:9.4,  return1y:15.8, return3y:9.8,  volatility:18.4, morningstar:3 },
    { id:"AB-006",  company:"聯博", name:"聯博AI人工智能基金",     category:"股票型", region:"全球",   dividendYield:0,   return1m:3.4, return3m:10.2, return6m:19.6, return1y:32.8, return3y:20.8, volatility:22.4, morningstar:5 },
    { id:"AB-007",  company:"聯博", name:"聯博印度成長基金",       category:"股票型", region:"印度",   dividendYield:0,   return1m:2.2, return3m:6.6,  return6m:12.4, return1y:20.4, return3y:14.0, volatility:22.8, morningstar:4 },
    { id:"AB-008",  company:"聯博", name:"聯博日本策略基金",       category:"股票型", region:"日本",   dividendYield:0,   return1m:1.8, return3m:5.4,  return6m:10.2, return1y:17.8, return3y:11.6, volatility:15.8, morningstar:3 },
    { id:"AB-009",  company:"聯博", name:"聯博多元資產收益基金",   category:"平衡型", region:"全球",   dividendYield:5.8, return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.4, return3y:7.0,  volatility:8.8,  morningstar:4 },
    { id:"AB-010",  company:"聯博", name:"聯博中國股票基金",       category:"股票型", region:"中國",   dividendYield:0,   return1m:1.2, return3m:3.6,  return6m:7.2,  return1y:12.4, return3y:7.8,  volatility:19.4, morningstar:3 },
    { id:"AB-011",  company:"聯博", name:"聯博短期優質債基金",     category:"債券型", region:"美國",   dividendYield:4.2, return1m:0.3, return3m:1.0,  return6m:2.0,  return1y:4.2,  return3y:2.8,  volatility:3.4,  morningstar:3 },
    { id:"AB-012",  company:"聯博", name:"聯博東南亞股票基金",     category:"股票型", region:"亞洲",   dividendYield:0,   return1m:1.4, return3m:4.2,  return6m:8.0,  return1y:13.4, return3y:8.4,  volatility:17.2, morningstar:3 },
    { id:"AB-013",  company:"聯博", name:"聯博全球轉型經濟基金",   category:"股票型", region:"全球",   dividendYield:0,   return1m:1.8, return3m:5.4,  return6m:10.2, return1y:17.4, return3y:11.4, volatility:16.4, morningstar:4 },
    { id:"AB-014",  company:"聯博", name:"聯博環球優質債基金",     category:"債券型", region:"全球",   dividendYield:3.8, return1m:0.4, return3m:1.2,  return6m:2.4,  return1y:4.8,  return3y:3.2,  volatility:5.0,  morningstar:3 },
    { id:"AB-015",  company:"聯博", name:"聯博台灣成長基金",       category:"股票型", region:"台灣",   dividendYield:0,   return1m:2.2, return3m:6.6,  return6m:12.4, return1y:22.8, return3y:15.2, volatility:15.4, morningstar:4 },
    // ---- 摩根 ----
    { id:"JPM-001", company:"摩根", name:"摩根太平洋科技基金",     category:"股票型", region:"亞洲",   dividendYield:0,   return1m:3.2, return3m:9.6,  return6m:18.4, return1y:31.2, return3y:21.8, volatility:20.8, morningstar:5 },
    { id:"JPM-002", company:"摩根", name:"摩根收益基金",           category:"平衡型", region:"全球",   dividendYield:5.4, return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:9.8,  return3y:6.4,  volatility:8.2,  morningstar:4 },
    { id:"JPM-003", company:"摩根", name:"摩根亞太入息基金",       category:"股票型", region:"亞洲",   dividendYield:4.8, return1m:1.4, return3m:4.2,  return6m:8.4,  return1y:14.2, return3y:9.4,  volatility:13.2, morningstar:3 },
    { id:"JPM-004", company:"摩根", name:"摩根美國科技基金",       category:"股票型", region:"美國",   dividendYield:0,   return1m:3.6, return3m:10.8, return6m:20.4, return1y:30.8, return3y:20.4, volatility:20.2, morningstar:5 },
    { id:"JPM-005", company:"摩根", name:"摩根新興市場債基金",     category:"債券型", region:"新興市場",dividendYield:5.8, return1m:0.6, return3m:1.8,  return6m:3.6,  return1y:6.8,  return3y:4.4,  volatility:7.8,  morningstar:3 },
    { id:"JPM-006", company:"摩根", name:"摩根印度基金",           category:"股票型", region:"印度",   dividendYield:0,   return1m:2.2, return3m:6.6,  return6m:12.4, return1y:20.8, return3y:14.2, volatility:22.8, morningstar:4 },
    { id:"JPM-007", company:"摩根", name:"摩根中國基金",           category:"股票型", region:"中國",   dividendYield:0,   return1m:1.2, return3m:3.6,  return6m:7.2,  return1y:12.4, return3y:7.8,  volatility:19.4, morningstar:3 },
    { id:"JPM-008", company:"摩根", name:"摩根日本精選基金",       category:"股票型", region:"日本",   dividendYield:0,   return1m:1.8, return3m:5.4,  return6m:10.2, return1y:17.6, return3y:11.4, volatility:15.8, morningstar:3 },
    { id:"JPM-009", company:"摩根", name:"摩根多重資產基金",       category:"平衡型", region:"全球",   dividendYield:5.6, return1m:1.0, return3m:3.0,  return6m:6.0,  return1y:10.4, return3y:7.0,  volatility:8.8,  morningstar:4 },
    { id:"JPM-010", company:"摩根", name:"摩根東南亞基金",         category:"股票型", region:"亞洲",   dividendYield:0,   return1m:1.4, return3m:4.2,  return6m:8.0,  return1y:13.8, return3y:8.8,  volatility:17.8, morningstar:3 },
    { id:"JPM-011", company:"摩根", name:"摩根全球股票入息基金",   category:"股票型", region:"全球",   dividendYield:4.2, return1m:1.6, return3m:4.8,  return6m:9.2,  return1y:15.4, return3y:10.2, volatility:12.4, morningstar:4 },
    { id:"JPM-012", company:"摩根", name:"摩根投資級公司債基金",   category:"債券型", region:"美國",   dividendYield:4.4, return1m:0.4, return3m:1.2,  return6m:2.4,  return1y:4.8,  return3y:3.2,  volatility:5.2,  morningstar:3 },
    { id:"JPM-013", company:"摩根", name:"摩根台灣科技基金",       category:"股票型", region:"台灣",   dividendYield:0,   return1m:3.2, return3m:9.6,  return6m:18.4, return1y:31.8, return3y:22.4, volatility:22.4, morningstar:4 },
    { id:"JPM-014", company:"摩根", name:"摩根歐洲策略股利基金",   category:"股票型", region:"歐洲",   dividendYield:4.2, return1m:1.4, return3m:4.2,  return6m:8.4,  return1y:14.2, return3y:9.4,  volatility:13.4, morningstar:3 },
    { id:"JPM-015", company:"摩根", name:"摩根全球非投資級債基金", category:"債券型", region:"全球",   dividendYield:7.2, return1m:0.9, return3m:2.8,  return6m:5.4,  return1y:9.4,  return3y:6.4,  volatility:8.8,  morningstar:4 },
    // ---- 貝萊德 ----
    { id:"BLK-001", company:"貝萊德", name:"貝萊德世界基金",         category:"股票型", region:"全球",   dividendYield:0,   return1m:2.2, return3m:6.6, return6m:12.4, return1y:20.6, return3y:12.8, volatility:13.6, morningstar:4 },
    { id:"BLK-002", company:"貝萊德", name:"貝萊德美國靈活股票基金", category:"股票型", region:"美國",   dividendYield:0,   return1m:2.6, return3m:7.8, return6m:14.8, return1y:23.4, return3y:14.8, volatility:14.8, morningstar:4 },
    { id:"BLK-003", company:"貝萊德", name:"貝萊德新興市場基金",     category:"股票型", region:"新興市場",dividendYield:0,  return1m:1.4, return3m:4.2, return6m:8.4,  return1y:13.8, return3y:8.4,  volatility:17.4, morningstar:3 },
    { id:"BLK-004", company:"貝萊德", name:"貝萊德全球政府債券基金", category:"債券型", region:"全球",   dividendYield:3.8, return1m:0.3, return3m:0.9, return6m:2.0,  return1y:4.2,  return3y:2.6,  volatility:4.4,  morningstar:3 },
    { id:"BLK-005", company:"貝萊德", name:"貝萊德印度基金",         category:"股票型", region:"印度",   dividendYield:0,   return1m:2.2, return3m:6.6, return6m:12.4, return1y:20.8, return3y:14.2, volatility:23.4, morningstar:4 },
    { id:"BLK-006", company:"貝萊德", name:"貝萊德中國基金",         category:"股票型", region:"中國",   dividendYield:0,   return1m:1.2, return3m:3.6, return6m:7.2,  return1y:12.4, return3y:7.8,  volatility:19.4, morningstar:3 },
    { id:"BLK-007", company:"貝萊德", name:"貝萊德日本基金",         category:"股票型", region:"日本",   dividendYield:0,   return1m:1.8, return3m:5.4, return6m:10.2, return1y:17.6, return3y:11.4, volatility:15.8, morningstar:3 },
    { id:"BLK-008", company:"貝萊德", name:"貝萊德全球多元收益基金", category:"平衡型", region:"全球",   dividendYield:5.8, return1m:1.0, return3m:3.0, return6m:6.0,  return1y:10.4, return3y:7.0,  volatility:8.8,  morningstar:4 },
    { id:"BLK-009", company:"貝萊德", name:"貝萊德亞洲高收益債基金", category:"債券型", region:"亞洲",   dividendYield:6.8, return1m:0.8, return3m:2.4, return6m:4.8,  return1y:8.4,  return3y:5.6,  volatility:7.4,  morningstar:4 },
    { id:"BLK-010", company:"貝萊德", name:"貝萊德歐洲基金",         category:"股票型", region:"歐洲",   dividendYield:0,   return1m:1.6, return3m:4.8, return6m:9.2,  return1y:15.4, return3y:10.2, volatility:14.8, morningstar:3 },
    { id:"BLK-011", company:"貝萊德", name:"貝萊德科技基金",         category:"股票型", region:"全球",   dividendYield:0,   return1m:3.2, return3m:9.6, return6m:18.4, return1y:30.8, return3y:18.8, volatility:21.8, morningstar:5 },
    { id:"BLK-012", company:"貝萊德", name:"貝萊德全球高收益債基金", category:"債券型", region:"全球",   dividendYield:7.2, return1m:0.9, return3m:2.8, return6m:5.4,  return1y:9.2,  return3y:6.4,  volatility:8.4,  morningstar:4 },
    { id:"BLK-013", company:"貝萊德", name:"貝萊德東南亞基金",       category:"股票型", region:"亞洲",   dividendYield:0,   return1m:1.4, return3m:4.2, return6m:8.0,  return1y:13.8, return3y:8.8,  volatility:17.8, morningstar:3 },
    { id:"BLK-014", company:"貝萊德", name:"貝萊德台灣基金",         category:"股票型", region:"台灣",   dividendYield:0,   return1m:2.0, return3m:6.0, return6m:11.4, return1y:20.8, return3y:14.0, volatility:15.4, morningstar:3 },
    // ---- 霸菱 ----
    { id:"BAR-001", company:"霸菱", name:"霸菱優先順位資產抵押債券基金", category:"債券型", region:"全球", dividendYield:5.8, return1m:0.5, return3m:1.6, return6m:3.2, return1y:6.2, return3y:4.1, volatility:4.2, morningstar:4 },
    { id:"BAR-002", company:"霸菱", name:"霸菱亞洲基金",           category:"股票型", region:"亞洲",   dividendYield:0,   return1m:1.6, return3m:4.8, return6m:9.2, return1y:14.2, return3y:8.6,  volatility:17.8, morningstar:3 },
    { id:"BAR-003", company:"霸菱", name:"霸菱全球高收益債基金",   category:"債券型", region:"全球",   dividendYield:7.4, return1m:0.9, return3m:2.6, return6m:5.2, return1y:8.8,  return3y:5.8,  volatility:8.2,  morningstar:3 },
    { id:"BAR-004", company:"霸菱", name:"霸菱歐洲基金",           category:"股票型", region:"歐洲",   dividendYield:0,   return1m:1.8, return3m:5.4, return6m:10.2,return1y:16.8, return3y:10.8, volatility:14.8, morningstar:3 },
    { id:"BAR-005", company:"霸菱", name:"霸菱東南亞基金",         category:"股票型", region:"亞洲",   dividendYield:0,   return1m:1.4, return3m:4.2, return6m:8.0, return1y:13.4, return3y:8.4,  volatility:17.2, morningstar:3 },
    { id:"BAR-006", company:"霸菱", name:"霸菱印度基金",           category:"股票型", region:"印度",   dividendYield:0,   return1m:2.0, return3m:6.0, return6m:11.4,return1y:19.4, return3y:13.0, volatility:22.4, morningstar:3 },
    { id:"BAR-007", company:"霸菱", name:"霸菱中國成長基金",       category:"股票型", region:"中國",   dividendYield:0,   return1m:1.2, return3m:3.6, return6m:7.2, return1y:12.4, return3y:7.8,  volatility:19.4, morningstar:3 },
    { id:"BAR-008", company:"霸菱", name:"霸菱多元資產基金",       category:"平衡型", region:"全球",   dividendYield:5.4, return1m:0.9, return3m:2.8, return6m:5.4, return1y:9.4,  return3y:6.4,  volatility:8.4,  morningstar:3 },
    { id:"BAR-009", company:"霸菱", name:"霸菱新興市場債券基金",   category:"債券型", region:"新興市場",dividendYield:6.4, return1m:0.7, return3m:2.1, return6m:4.2, return1y:7.8,  return3y:5.2,  volatility:8.8,  morningstar:3 },
    { id:"BAR-010", company:"霸菱", name:"霸菱美國高收益債基金",   category:"債券型", region:"美國",   dividendYield:7.4, return1m:1.0, return3m:3.0, return6m:5.8, return1y:9.8,  return3y:6.8,  volatility:8.4,  morningstar:3 },
    // ---- 施羅德 ----
    { id:"SCH-001", company:"施羅德", name:"施羅德環球股息收益基金",    category:"股票型", region:"全球",   dividendYield:4.2, return1m:1.6, return3m:4.8, return6m:9.2, return1y:15.4, return3y:10.2, volatility:11.8, morningstar:4 },
    { id:"SCH-002", company:"施羅德", name:"施羅德新興市場基金",        category:"股票型", region:"新興市場",dividendYield:0,  return1m:1.2, return3m:3.6, return6m:7.2, return1y:10.4, return3y:5.8,  volatility:19.2, morningstar:3 },
    { id:"SCH-003", company:"施羅德", name:"施羅德亞洲高收益債券基金",  category:"債券型", region:"亞洲",   dividendYield:6.4, return1m:0.7, return3m:2.1, return6m:4.2, return1y:7.8,  return3y:5.2,  volatility:7.2,  morningstar:3 },
    { id:"SCH-004", company:"施羅德", name:"施羅德環球能源轉型基金",    category:"股票型", region:"全球",   dividendYield:0,   return1m:1.4, return3m:4.2, return6m:8.0, return1y:14.8, return3y:9.4,  volatility:16.4, morningstar:3 },
    { id:"SCH-005", company:"施羅德", name:"施羅德印度機會基金",        category:"股票型", region:"印度",   dividendYield:0,   return1m:2.2, return3m:6.6, return6m:12.4,return1y:20.8, return3y:14.2, volatility:23.4, morningstar:4 },
    { id:"SCH-006", company:"施羅德", name:"施羅德日本股票基金",        category:"股票型", region:"日本",   dividendYield:0,   return1m:1.8, return3m:5.4, return6m:10.2,return1y:17.4, return3y:11.2, volatility:15.8, morningstar:3 },
    { id:"SCH-007", company:"施羅德", name:"施羅德多重資產基金",        category:"平衡型", region:"全球",   dividendYield:5.4, return1m:1.0, return3m:3.0, return6m:6.0, return1y:10.2, return3y:6.8,  volatility:8.8,  morningstar:4 },
    { id:"SCH-008", company:"施羅德", name:"施羅德環球高息股基金",      category:"股票型", region:"全球",   dividendYield:4.8, return1m:1.4, return3m:4.2, return6m:8.4, return1y:14.2, return3y:9.4,  volatility:13.4, morningstar:3 },
    { id:"SCH-009", company:"施羅德", name:"施羅德美國股票基金",        category:"股票型", region:"美國",   dividendYield:0,   return1m:2.6, return3m:7.8, return6m:14.8,return1y:24.2, return3y:15.8, volatility:16.8, morningstar:4 },
    { id:"SCH-010", company:"施羅德", name:"施羅德東南亞基金",          category:"股票型", region:"亞洲",   dividendYield:0,   return1m:1.4, return3m:4.2, return6m:8.0, return1y:13.4, return3y:8.4,  volatility:17.4, morningstar:3 },
    { id:"SCH-011", company:"施羅德", name:"施羅德全球非投資級債基金",  category:"債券型", region:"全球",   dividendYield:7.2, return1m:0.9, return3m:2.8, return6m:5.4, return1y:9.2,  return3y:6.4,  volatility:8.4,  morningstar:4 },
    { id:"SCH-012", company:"施羅德", name:"施羅德中國股票基金",        category:"股票型", region:"中國",   dividendYield:0,   return1m:1.2, return3m:3.6, return6m:7.2, return1y:12.4, return3y:7.8,  volatility:19.4, morningstar:3 },
    { id:"SCH-013", company:"施羅德", name:"施羅德歐洲股票基金",        category:"股票型", region:"歐洲",   dividendYield:0,   return1m:1.6, return3m:4.8, return6m:9.2, return1y:15.4, return3y:10.2, volatility:14.8, morningstar:3 },
  ];
  
  export const FUND_LIST: Fund[] = RAW_FUNDS.map(r => {
    const yieldA = r.dividendYield;
    const yieldM = yieldA > 0 ? parseFloat((yieldA / 12).toFixed(3)) : 0;
    const perUnit = yieldA > 0 ? parseFloat((yieldA * 0.12).toFixed(4)) : 0;
    return {
      id: r.id,
      company: r.company,
      name: r.name,
      category: r.category,
      region: r.region,
      morningstar: r.morningstar,
      dividendPerUnit: perUnit,
      dividendFreq: fundFreq(yieldA),
      dividendYieldM: yieldM,
      dividendYieldA: yieldA,
      returnYTD: parseFloat((r.return1y * 0.52).toFixed(1)),
      return1m: r.return1m,
      return3m: r.return3m,
      return6m: r.return6m,
      return1y: r.return1y,
      return3y: r.return3y,
      volatility: r.volatility,
    };
  });
  
  export const COMPANIES = Array.from(new Set(FUND_LIST.map(f => f.company)));
  export const CATEGORIES = Array.from(new Set(FUND_LIST.map(f => f.category)));
  export const REGIONS    = Array.from(new Set(FUND_LIST.map(f => f.region)));