// 投信官網月報的「基金代號(sourceId) → 我方funds.id」靜態對應表（2026-11-03）。
//
// 為什麼是靜態表、不是每次排程即時爬：元大(191檔)、國泰(175檔)要列出完整清單都需要在官網SPA
// 裡逐一點擊(元大翻頁、國泰"顯示更多"+逐列點擊讀URL)才拿得到內部ID，一次要花10-25分鐘，遠超過
// 單次cron安全的執行時間；野村則是用官網自己的JSON API（FundIntroList+FundGradeOptions）一次抓
// 完43組不到10秒。三家都改成「定期(人工重新執行lib/..內對應的discover_*腳本)離線產生這份表、
// commit進repo」，排程本身只讀這份表、不再即時探索——跟既有etf-official-holdings引用的
// universe_by_issuer.json是同一套模式。
//
// 比對規則（使用者核准）：優先用官網頁面上的統編/ISIN/代碼精確比對；只能用名稱比對的，名稱要
// 完全相符且只對到唯一一筆；對不上的不猜、不列入這份表。多級別基金的持股屬於基金層級，
// fundIds可以是多筆（同一檔基金的所有APPROVED、非superseded share class共用同一份月報）。
//
// sourceId 格式：
//   YUANTA: 元大官網 /myfund/information/<id> 的 <id>（純數字字串）
//   CATHAY: 國泰官網 /fund-details/<code> 的 <code>（如 "F01"）
//   NOMURA: 野村官網 "<groupId>::<gradeId>"（查詢持股頁需要兩者）
export type IssuerFundMapping = { sourceId: string; fundIds: string[] };

// 元大投信：discover_yuanta_full.mjs（翻頁收集191檔）+ 名稱精確比對（funds.name）。
// 2026-11-03 VERIFIED：80/191命中，純exact match、0筆ambiguous；其餘111檔是ETF/期貨信託類
// 商品，本來就不在funds表範圍（屬於etfs表，已由etf-official-holdings涵蓋），不是漏抓。
export const YUANTA_FUND_MAPPINGS: IssuerFundMapping[] = [
  { sourceId: "1277", fundIds: ["deb81426-667f-4076-8ad2-73d45f57a5a1"] }, // 元大高科技基金-新台幣N類型 (81584335B)
  { sourceId: "1008", fundIds: ["c1f9ef68-e535-4337-831e-090f94127421"] }, // 元大高科技基金-新台幣A類型 (81584335A)
  { sourceId: "1007", fundIds: ["c150d81b-e79b-4ba2-a9a8-41c76b88ed0b"] }, // 元大萬泰貨幣市場基金 (20081331)
  { sourceId: "1143", fundIds: ["2acc8245-825f-42e7-b3a4-23fe4d89c69c"] }, // 元大美元貨幣市場基金-美元 (42381754B)
  { sourceId: "1142", fundIds: ["2f1a84cf-9eb4-42d2-94d7-bc929538f55e"] }, // 元大美元貨幣市場基金-新台幣 (42381754A)
  { sourceId: "1278", fundIds: ["f6d14b17-5867-425f-a0aa-04ba2ab64ca5"] }, // 元大經貿基金-新台幣N類型 (83863951B)
  { sourceId: "1009", fundIds: ["4630707a-0a69-4069-8773-22e70fe74774"] }, // 元大經貿基金-新台幣A類型 (83863951A)
  { sourceId: "1252", fundIds: ["7a1e3b57-4a36-48aa-b453-8e838361d5e5"] }, // 元大標普500ETF連結基金 (00607158)
  { sourceId: "1285", fundIds: ["1ea7e14d-3edc-4224-9c5f-6718872063e9"] }, // 元大日本龍頭企業基金-美元N類型 (93100953H)
  { sourceId: "1241", fundIds: ["20da8fd2-cca5-463d-bcfb-bb4ee5d8ce77"] }, // 元大日本龍頭企業基金-美元I類型 (93100953D)
  { sourceId: "1286", fundIds: ["d8774287-2555-4059-bc6d-c7dcdc764944"] }, // 元大日本龍頭企業基金-日圓N類型 (93100953I)
  { sourceId: "1243", fundIds: ["a9149de4-e64e-4ac4-9f64-ef81d38c8c7b"] }, // 元大日本龍頭企業基金-日圓I類型 (93100953F)
  { sourceId: "1284", fundIds: ["d4f9d07c-046f-4a01-ac85-b730041ba51e"] }, // 元大日本龍頭企業基金-新台幣N類型 (93100953G)
  { sourceId: "1235", fundIds: ["10f8bb0f-c55b-4da2-a8d3-9a345474e3ef"] }, // 元大日本龍頭企業基金-新台幣I類型 (93100953B)
  { sourceId: "1046", fundIds: ["8df1fbc1-3514-48f2-8558-af4a4e2f70d7"] }, // 元大新興亞洲基金 (25643156)
  { sourceId: "1279", fundIds: ["38975b98-30d0-4a42-a193-2c72bca39be4"] }, // 元大新主流基金-新台幣N類型 (17139204B)
  { sourceId: "1013", fundIds: ["45aaa9e6-ce01-4f24-aabc-525be35db790"] }, // 元大新主流基金-新台幣A類型 (17139204A)
  { sourceId: "1132", fundIds: ["aa5f2121-f79d-4520-b7bd-0da69d3d2753"] }, // 元大新中國基金-美元 (25520400B)
  { sourceId: "1044", fundIds: ["9319606c-ed54-4e15-907d-f7b7cf1c7b32"] }, // 元大新中國基金-新台幣 (25520400A)
  { sourceId: "1133", fundIds: ["0bf97292-f979-47e1-b9b8-2cf72fdad2aa"] }, // 元大新中國基金-人民幣 (25520400C)
  { sourceId: "1063", fundIds: ["4bf1ff7e-00f4-449d-8283-e79e0a6e6d92"] }, // 元大得寶貨幣市場基金 (13530495)
  { sourceId: "1057", fundIds: ["6dec0d61-322d-412e-8ba6-b00c09c8d47e"] }, // 元大得利貨幣市場基金 (92017204)
  { sourceId: "1006", fundIds: ["c70643d6-38f7-46d6-8f9e-4d98a3d9853f"] }, // 元大店頭基金 (20080023)
  { sourceId: "1096", fundIds: ["1c0f0d90-fce4-4f84-b489-e5b047e6142c"] }, // 元大巴西指數基金 (26203851)
  { sourceId: "1197", fundIds: ["26aeae46-1dc6-45de-9edd-ba85cf1cb9f0"] }, // 元大富櫃50ETF連結基金-新台幣B類型配息 (75971153B)
  { sourceId: "1196", fundIds: ["09622667-aa63-4e12-9217-e2fd9fd79f79"] }, // 元大富櫃50ETF連結基金-新台幣A類型不配息 (75971153A)
  { sourceId: "1136", fundIds: ["d79b5623-80ff-4c59-b4c8-a328e2ac35b3"] }, // 元大大中華價值指數基金-美元 (25591306B)
  { sourceId: "1089", fundIds: ["5db26f3a-330e-45b8-a476-50fd502c3901"] }, // 元大大中華價值指數基金-新台幣 (25591306A)
  { sourceId: "1137", fundIds: ["198166d5-724d-4e1f-8989-6846571f5124"] }, // 元大大中華價值指數基金-人民幣 (25591306C)
  { sourceId: "1118", fundIds: ["ef4b41b8-aadb-47bd-ae23-392ea5cfa6ec"] }, // 元大大中華TMT基金-新台幣 (38639090A)
  { sourceId: "1119", fundIds: ["6664f6d5-0d1e-4641-9d60-fed11ec3310e"] }, // 元大大中華TMT基金-人民幣 (38639090B)
  { sourceId: "1274", fundIds: ["8c09fb20-9b46-491d-ae3a-1992b4dca7cc"] }, // 元大多福基金-新台幣N類型 (01032058B)
  { sourceId: "1002", fundIds: ["1511d0b9-6c05-4ff3-a7db-5189731c3be6"] }, // 元大多福基金-新台幣A類型 (01032058A)
  { sourceId: "1275", fundIds: ["3d3697e5-fe85-4442-88f7-8e225f98d786"] }, // 元大多多基金-新台幣N類型 (92001765B)
  { sourceId: "1003", fundIds: ["22e0e425-41a4-440e-a075-6a2ee2ef27c3"] }, // 元大多多基金-新台幣A類型 (92001765A)
  { sourceId: "1250", fundIds: ["b8a54baa-a3af-43fe-953e-0cdca22a780c"] }, // 元大台灣卓越50ETF連結基金-新台幣TISA類型 (75970963C)
  { sourceId: "1193", fundIds: ["2afdcc8e-334d-4339-ab1c-08b2959af4a3"] }, // 元大台灣卓越50ETF連結基金-新台幣B類型配息 (75970963B)
  { sourceId: "1192", fundIds: ["85b51b9c-8a3e-4091-9829-1a00bb2348fb"] }, // 元大台灣卓越50ETF連結基金-新台幣A類型不配息 (75970963A)
  { sourceId: "1208", fundIds: ["e8f57357-285b-40eb-a3c5-140b8b6d17dc"] }, // 元大台灣加權股價指數基金-新台幣R類型 (99346928B)
  { sourceId: "1071", fundIds: ["3d771886-d0c7-4535-b6f8-e75cf1bc9a70"] }, // 元大台灣加權股價指數基金-新台幣A類型 (99346928A)
  { sourceId: "1045", fundIds: ["88c95b85-ef1b-425b-b237-e78e13d35e04"] }, // 元大印度基金 (25622390)
  { sourceId: "1098", fundIds: ["7b541e90-5886-4570-997a-dd9e2474c70a"] }, // 元大印尼指數基金 (26203846)
  { sourceId: "1276", fundIds: ["03f91299-9853-4c12-96c7-d20420c052dc"] }, // 元大卓越基金-新台幣N類型 (92026219B)
  { sourceId: "1004", fundIds: ["aa3f0e29-5df6-4869-ac4e-fe6b1500ba0c"] }, // 元大卓越基金-新台幣A類型 (92026219A)
  { sourceId: "1041", fundIds: ["dbc17526-5f5b-4301-a820-ff748e7f9f3c"] }, // 元大全球農業商機基金 (10348058)
  { sourceId: "1253", fundIds: ["f370a80e-8bf8-4222-b3d3-b282e2e519fc"] }, // 元大全球航太與防衛科技ETF連結基金 (00607143)
  { sourceId: "1077", fundIds: ["34a1d7e6-060f-42e6-9603-d9a9937ecfde"] }, // 元大全球新興市場精選組合基金 (48760113)
  { sourceId: "1281", fundIds: ["9738d13c-8682-4167-821e-18351bd91259"] }, // 元大全球優質龍頭平衡基金-美元N類型 (88320598F)
  { sourceId: "1212", fundIds: ["96cc4f7f-3d61-43f7-96a1-423bef8fff9a"] }, // 元大全球優質龍頭平衡基金-美元I類型 (88320598D)
  { sourceId: "1280", fundIds: ["cfbdf13a-cf2c-440d-87e2-50f1fa2bd777"] }, // 元大全球優質龍頭平衡基金-新台幣N類型 (88320598E)
  { sourceId: "1211", fundIds: ["61ae9fd8-14c3-4d4a-950d-9c901f2085fd"] }, // 元大全球優質龍頭平衡基金-新台幣I類型 (88320598C)
  { sourceId: "1207", fundIds: ["237b609e-219c-4728-b252-41fb29ba6bfc"] }, // 元大全球ETF穩健組合基金-新台幣R類型 (99967974B)
  { sourceId: "1072", fundIds: ["4f8f9236-ee41-4df4-99f8-292a11690bd8"] }, // 元大全球ETF穩健組合基金-新台幣A類型 (99967974A)
  { sourceId: "1079", fundIds: ["2837aba3-a003-4bad-b183-4b555445927e"] }, // 元大全球ETF成長組合基金 (48789815)
  { sourceId: "1114", fundIds: ["db4f8e6a-9062-4e9e-8892-69b74d75c2ec"] }, // 元大人民幣貨幣市場基金-新台幣 (38546966A)
  { sourceId: "1115", fundIds: ["472ba673-0c21-44f6-8065-262503b11d81"] }, // 元大人民幣貨幣市場基金-人民幣 (38546966B)
  { sourceId: "1027", fundIds: ["fcbd8dff-daf0-4b4a-8e5e-0e0a255fa8d9"] }, // 元大亞太成長基金 (48708243)
  { sourceId: "1283", fundIds: ["5c2df1c0-2fe9-454f-9e03-7915c18e587b"] }, // 元大2至10年投資級企業債券基金-美元N類型配息級別 (88339533J)
  { sourceId: "1228", fundIds: ["aeefa03f-a802-444a-8a56-6f61651ef7ec"] }, // 元大2至10年投資級企業債券基金-美元I類型配息級別 (88339533H)
  { sourceId: "1227", fundIds: ["e98951e3-fe64-42c1-a646-ce6ee065c71f"] }, // 元大2至10年投資級企業債券基金-美元I類型累積級別 (88339533G)
  { sourceId: "1218", fundIds: ["b623e587-5443-4563-88e7-b0118b90eefb"] }, // 元大2至10年投資級企業債券基金-美元B類型配息 (88339533D)
  { sourceId: "1217", fundIds: ["5ade9de8-d64a-4e42-b103-8165adacd54f"] }, // 元大2至10年投資級企業債券基金-美元A類型不配息 (88339533C)
  { sourceId: "1282", fundIds: ["ba6ad22c-1e4b-4696-affb-4570f2d17902"] }, // 元大2至10年投資級企業債券基金-新台幣N類型配息級別 (88339533I)
  { sourceId: "1226", fundIds: ["7514a1df-187a-4762-a73b-08a0e3bd023f"] }, // 元大2至10年投資級企業債券基金-新台幣I類型配息級別 (88339533F)
  { sourceId: "1225", fundIds: ["48e1c98e-5304-457c-adac-2141fc7d17a2"] }, // 元大2至10年投資級企業債券基金-新台幣I類型累積級別 (88339533E)
  { sourceId: "1216", fundIds: ["0dea723f-dbcb-4d80-8c49-7f1dce3edd1d"] }, // 元大2至10年投資級企業債券基金-新台幣B類型配息 (88339533B)
  { sourceId: "1215", fundIds: ["ecba32b4-5147-4fd9-9d9e-e376f819d12b"] }, // 元大2至10年投資級企業債券基金-新台幣A類型不配息 (88339533A)
  { sourceId: "1055", fundIds: ["a62ca4ac-5194-4ec2-aef3-957e3fffe439"] }, // 元大2001基金 (00974066)
  { sourceId: "1232", fundIds: ["ec11ba4e-1e5a-4567-81eb-4ad9db3f54ca"] }, // 元大10年以上投資級企業債券基金-美元I類型配息級別 (88339549H)
  { sourceId: "1231", fundIds: ["881d9a52-f3b0-477f-b590-a8401c407998"] }, // 元大10年以上投資級企業債券基金-美元I類型累積級別 (88339549G)
  { sourceId: "1222", fundIds: ["6e000f75-8513-4922-8a84-1c7af0d361da"] }, // 元大10年以上投資級企業債券基金-美元B類型配息 (88339549D)
  { sourceId: "1221", fundIds: ["4ee5debf-fb0b-4442-a9a9-ef342c7a39a2"] }, // 元大10年以上投資級企業債券基金-美元A類型不配息 (88339549C)
  { sourceId: "1230", fundIds: ["eb22503e-7cc8-4465-8d59-221f094bf363"] }, // 元大10年以上投資級企業債券基金-新台幣I類型配息級別 (88339549F)
  { sourceId: "1229", fundIds: ["24ee924f-f3ec-4f7a-83ad-d79d809845aa"] }, // 元大10年以上投資級企業債券基金-新台幣I類型累積級別 (88339549E)
  { sourceId: "1220", fundIds: ["9c81e46b-592e-4bbb-8524-4a6f1ff95e34"] }, // 元大10年以上投資級企業債券基金-新台幣B類型配息 (88339549B)
  { sourceId: "1219", fundIds: ["6a0637a8-2cdc-4417-87d0-d3d7d3fd5dcc"] }, // 元大10年以上投資級企業債券基金-新台幣A類型不配息 (88339549A)
  { sourceId: "1224", fundIds: ["2fe117a2-7516-4e4c-9a12-fad16ed61f34"] }, // 元大0至2年投資級企業債券基金-美元I類型 (88339528D)
  { sourceId: "1214", fundIds: ["a3954b39-359c-4202-9780-f3b191d60261"] }, // 元大0至2年投資級企業債券基金-美元A類型 (88339528B)
  { sourceId: "1223", fundIds: ["0d7d5482-a525-4f68-9352-3e1914b79ca1"] }, // 元大0至2年投資級企業債券基金-新台幣I類型 (88339528C)
  { sourceId: "1213", fundIds: ["b0e15ae9-7c03-4943-bab5-c8105ddda4c3"] }, // 元大0至2年投資級企業債券基金-新台幣A類型 (88339528A)
];

// 野村投信：discover_nomura_full.mjs（官網自己的FundIntroList+FundGradeOptions JSON API，43組）
// + SITCA CSV（受野村投信scope限定的安全候選集合）精確比對基金層級名稱。
// 2026-11-03 VERIFIED：38/43組命中，0筆ambiguous；其餘5組是ETF連結型/新產品/命名差異
// （例如「野村 e 科技基金」SITCA跟官網之間多一個空白），正確回報不對應、沒有猜。
// fundIds是該組所有APPROVED、非superseded的share class——持股寫入時全部一起更新（基金層級）。
export const NOMURA_FUND_MAPPINGS: IssuerFundMapping[] = [
  { sourceId: "6f67befa-b535-4aac-a0d3-2456fd6fec76::1848", fundIds: ["d74f0f88-81c2-4d0a-ab45-3947e2f51d4b", "d6f249e3-f991-4a1f-9f6f-f1ded15fc8ca"] }, // 野村臺灣智慧優選主動式ETF連結基金
  { sourceId: "bf1693a8-ac87-4633-b04a-58e7d96c4545::1744", fundIds: ["0f5ffecd-0697-4ba9-8dad-b2861424efea", "9e7753a2-fe3d-41f4-870a-9260f85aaf07", "04e05f62-a23d-41b8-9040-75f6573a19f7", "90a28f9e-7b33-4f75-b303-733a89a2930d", "59c30a02-4e74-4073-8412-50a57813b4e8", "2c1dcf56-aeef-4cf6-80a1-696c5b9c17f0", "3b34a7e9-d3d5-4f05-9086-5e50f54e7d03", "37839d31-dbf5-4a17-aa67-0a17c72d3ad0", "d65563c8-6ad7-4382-86d5-02c301663fcc", "1cdf98a6-01aa-4a41-9565-b61d99d73639", "050ec555-c9cc-44ea-a63a-c0f89b4455c6", "36e70c34-fe55-4433-a941-eb5ff993535b", "3bbd4e98-9ccf-48ef-90df-b8cae275b68b", "ff19ca49-b319-47a3-90e6-646731494062", "2a266867-4923-483d-97d6-e077b1d2aee0", "dcb8d043-994c-4aa2-afec-9e8f4390a918"] }, // 野村全球科技多重資產基金
  { sourceId: "99b34ead-e0cf-4274-b215-b89c6dc7809b::1871", fundIds: ["4e162be9-5033-4114-8c10-983f15a68d1b", "c020de6d-f506-42b7-8adf-771f73e35b07", "cc2bce0a-ec15-4f14-95ae-fbc4402a1026", "35988bf5-aacc-4071-96d3-2f74373d0018", "55869f45-3272-4839-a43a-47ac67f7cffc", "eaebee75-1d3f-4f82-b0fb-bd5d32a4c1cd", "e0edfbf9-d6f6-41ba-9e50-935984b116e3", "c94d31f1-27ea-47c7-8d63-b2c5ce43fa40", "50f8c46c-ea74-4713-982b-5a5d8434aff3", "ca134aa1-5e8c-42da-b6db-6e5d628bd840"] }, // 野村台日優選多重資產基金
  { sourceId: "58266F57-319D-4805-9658-98EEFEC86FDA::21", fundIds: ["364157fa-1b55-4dfc-b14d-5ecb4becea3d", "339cc817-b9f1-47f3-a313-06eaf977120a", "f875fd38-39ba-487c-afe2-f5bb91c727f3", "3791b392-e18e-465a-86ae-e48c96d6793b"] }, // 野村優質基金
  { sourceId: "E0FF51FB-DEC2-41F3-B66D-8F1A2991FFE7::27", fundIds: ["8b04d981-0b8c-495f-a474-c485c3a37330", "cffb2813-d62f-4c80-b834-2f02c32b0151"] }, // 野村鴻運基金
  { sourceId: "469E5292-0F81-4CB6-862B-E140B4BD2F51::31", fundIds: ["c1b7d796-4fdb-4075-a654-22de08f0319a", "9e27bb01-2c11-48e8-9af3-8bacfdd86c50"] }, // 野村中小基金
  { sourceId: "25973FEE-FDC6-47BC-8D9C-956A2324AD67::25", fundIds: ["e13cf1af-7691-4e15-a255-6afa5327d44d", "3b1c37be-1c06-463d-a007-83cc074453ae"] }, // 野村高科技基金
  { sourceId: "741E7108-25A5-48A1-875A-E069E125EDF4::23", fundIds: ["a45cf298-e247-4138-9ac3-a5a1eeae3baa", "b2566dae-d0de-44a9-b4e5-e30464711c44", "30ea0d54-17df-4568-8939-bcd878b59b57", "f40e3a74-becf-41ea-8a89-307482e78cbe"] }, // 野村環球基金
  { sourceId: "F6FC1004-FC44-4BBD-A4F5-3A9F217226B4::29", fundIds: ["e17cd912-230a-43c7-9da4-9a813a7afb33", "5149ce2b-d850-4b68-91ac-2b2d0f1acf72", "cdde3c9d-9ee1-4915-85cf-2f314f9bf353", "b27ca01a-5b43-4abc-a56e-666ba522d76a"] }, // 野村全球品牌基金
  { sourceId: "a43d7b50-1ad3-461f-9ca5-0d3f0314fef3::1081", fundIds: ["1885e06c-4203-4b97-8ba3-b6bafb117548", "36d25383-cc3c-4a20-bd8e-6397f42365e6"] }, // 野村日本領先基金
  { sourceId: "67989ff0-38d7-4b76-9e3a-c06425161196::1350", fundIds: ["fa6fa155-f561-4652-92fd-303d8cebf3bc", "1aee6698-c350-4e27-a51a-f5814fb50b1e", "59616a40-dee4-4099-b819-5e293da52c33", "d3596aec-de9c-4896-aef8-bcfff822fc48", "fdaa0b13-0812-4e77-aedb-cf41716f0ca4", "7d09d33b-d2d4-4845-a1cc-ded4cce3f806", "8d765b59-dab5-4e9c-8808-ecd7c05297b0", "f2ebf2d5-3a62-4920-ac2f-d51b3cb2b98a", "b61a5836-294c-41dc-8851-6d8f106e0396", "b4c8472d-e2b5-4572-9eb2-3a10c4fd754f", "e3fd433f-64ca-4c3b-a3a6-7003721fc535", "7be32bb4-078b-4ee5-acde-6830deff0a88", "1310413d-11e8-4862-ae57-a3801654abab", "cda44d86-fe42-4859-8e9a-1e3457665fc7"] }, // 野村全球金融收益基金
  { sourceId: "bd12d30a-7ac3-4d87-bea8-9843f77ffc86::1515", fundIds: ["ca9aa88c-0a9d-491e-9db5-7824fbcfad2f", "e1468b4a-8647-4cd1-a8bc-2bbb3b0136ea", "3946c770-bd19-42f5-92b1-90a4cd582762", "652464eb-0d81-4a34-b1a9-cabe2b341bf6", "17f31d5b-76c2-4285-aff7-5301042b1790", "464c0cb7-e1cd-4d48-bec0-cf4c2af3c2cd", "114cbfad-9f76-46e3-91fb-dbcb1d0b3501", "09af88d0-5230-4fba-a3a4-c22842d452ae", "78f3515f-af73-4de2-97f6-17d41b2a8c64", "3c03d25b-0a5e-4ebe-9b7a-63bb8e5cb7eb", "dbc90a29-8492-4597-9dc1-2c8c8ffead32", "b9e13a2f-1b5c-4521-917a-6f117b17160f", "377b1018-19ab-4198-8aad-2c86a64efef4", "173c0ff9-7b6a-4afc-a017-df79f91a94b3"] }, // 野村特別時機非投資等級債券基金
  { sourceId: "ec9d3dea-6090-4e10-b70b-97980ffd0394::1554", fundIds: ["031c97a7-48fa-4793-ac11-27a67ad1b9ce", "063cf2b1-b5c6-4e8c-be3a-50be5361b7d1", "92cd12a7-5c43-4cb9-be1d-da9344bb2864", "9e335674-d0de-4dbe-b0d1-dbef41f23faf", "c3e48561-443b-446c-b9c6-8d4224aaccef", "a18d4410-3b1d-4682-b1c2-d30e4046fa4c", "c8f1b120-19d5-4548-9ef0-05ad005209de"] }, // 野村全球基礎建設大未來基金
  { sourceId: "58704571-38AD-4C73-B1FC-C11937A0DF5A::33", fundIds: ["529d8b00-ed4d-4e24-889e-94ee0136fb94"] }, // 野村台灣運籌基金
  { sourceId: "EE1765BE-D782-4AEF-96FA-4C6970DAAD3E::7", fundIds: ["a04600d4-5ee4-4e55-8169-3f8108aa9f23"] }, // 野村成長基金
  { sourceId: "37c7f871-0153-4e12-89c6-34b68ef2099d::955", fundIds: ["6489487f-d129-4a76-a748-42a7e0abb6ae", "3e92ef1c-d042-42ae-abbf-7f90667dd65f", "72b5dcdb-23b9-4edb-a252-ceecc8a8ada0", "6276c12f-e8c1-439a-b83d-aea325bc08a8", "080a65fc-4211-41f8-96c6-072df9db165a", "3d637288-6e80-4193-999e-61a12e27009c", "a63f5d99-bc9a-4889-870b-9a051619f561", "034e0db1-375b-4782-b283-f9b9db12181e", "6c8b11f9-75be-4876-8c89-f1729e9cc3a4", "e601017b-e835-41e6-9dbe-2980511b7bcc", "62ce5642-ebd4-4a7d-8d91-bd43283f5b75"] }, // 野村亞太複合非投資等級債券基金
  { sourceId: "0a59f9ab-01ea-4a0f-95d0-84343025ea0d::1076", fundIds: ["b955ef8d-a0ac-4701-a4a1-bffb670b6b64", "c168bdfd-d600-4c29-8185-2303552e656d", "8af54637-324e-468e-a7f6-9cce3617683f", "643e136e-ab0e-49f4-8148-2bbb596cca18", "e3f014cb-6c69-427d-9384-de25ac0f87a9", "c7d3a30e-515d-40ee-9e08-ee3610de06f7", "c6917d0b-a219-4023-9e73-c240a25e34e7", "871913f0-957a-4cad-9318-363877bf7162"] }, // 野村美利堅非投資等級債券基金
  { sourceId: "2088126c-9136-41e7-b058-c70c4a78b5e1::1141", fundIds: ["4dcda188-6d80-4714-98d4-b1aa776e7e84", "772774b9-2720-4673-93e9-8406ea9102df", "a513338f-ccc7-4061-9986-2ca67618abdd", "2a57c422-a9d7-44ad-a055-e2e2388b9496", "68fa2a58-9d52-4a32-a26c-e7a2a7ef9a42"] }, // 野村全球短期收益基金
  { sourceId: "63cef057-fff8-44ce-bfd1-d92f8da6882f::1220", fundIds: ["45942c37-8ed4-4b24-aa06-9c10d4ec0514", "2fe9cfa7-c35b-48b2-a849-ee60d6ba964b", "9d37983b-231e-4fe9-a290-ed33d7a08c63", "870c3de5-6244-4286-a114-fb1cc0b78c53", "16b724dc-0169-4217-abb4-b0a0087cccf4", "71af3de5-43d6-4ca8-b9a5-0a702b2f40c2", "f2e366dc-f7dd-41f7-8aba-0cce9f1c1ca3", "6aa86b40-bea1-4ba7-8f6d-dbb2c118682e", "fc4cb37d-fa2e-4517-85d2-2221dc645012", "59ba5950-ed19-472d-abf5-eeae5e496d56", "8fed2e2e-b432-4602-a43a-a1d97a4e0578", "e11dd0e2-7aef-480f-b4a5-462bf3bdf3b1", "e33d6f5c-7807-4f7f-9e60-9fe5306522e4"] }, // 野村多元收益多重資產基金
  { sourceId: "eff23618-91df-4ce8-8571-ccb86f6c4102::1664", fundIds: ["11486379-9aed-41e1-9075-f6d39c22a19c", "6bfd6fe3-8fae-4672-a19b-56bd27ee0415", "6e526dba-3c7d-49fe-9b0a-3eae46a87c33", "bb184410-3985-478c-b274-4fc79ec9405d", "75533552-33b2-48b9-9cae-cbb27bb087a7", "5796be11-2b61-4f5b-adbf-70f839cc3f69", "14b98f19-b129-42be-9380-a56bcfad1e86", "3237c99b-14b9-4aef-9e9e-ec4eabe5c364", "48b86ab9-e695-4fd5-b270-74383763f90f"] }, // 野村環球時機多重資產基金
  { sourceId: "69520b11-9c32-4953-8a7f-359584ba1a6f::1696", fundIds: ["0a9f508d-e346-4c15-80ac-0ee0582130f4", "b521a6ee-c009-4309-a7df-d68b16b12923", "66fca65e-8cf3-4cdc-8eb4-b2024b9279f5", "ee4f00aa-2f40-419f-bacc-d38aaf9a20b5", "0146d471-7d49-4855-bdf3-dabbc1c2f002", "7cccad21-46b8-411f-8429-0a17d85e0eef", "c145e012-4f4b-4292-af60-23b9c1df1a2a", "b2e9f6ba-8e98-4fd2-a452-5a1d6fe1520b", "a5892220-d181-41fe-b24a-c5f58c46bbdf", "7a178409-c705-44f3-ab2b-376c7982f139", "221f6f96-0b5c-40da-a398-025eaa44bb22"] }, // 野村策略轉機多重資產基金
  { sourceId: "f9f370f9-e802-490c-bed7-8b9a08ed01cc::1776", fundIds: ["c92b789f-b796-4c11-8c47-d52c0ea8e860", "9e6411bd-c8c1-46fa-b120-8a948557ec19", "2dfb8dce-f779-4efd-a196-5569e0f46659", "effde020-70b5-4de6-bf02-32115f688a01", "a933bbe8-96bb-42ed-9d57-2e060756518f", "6f395814-741e-4580-b229-ca0fff0069c1", "82439ed3-e653-4b6b-a9eb-2efcdff26e6f", "e93b4f5f-f964-4fdc-8377-cdadb31c62f8", "4d4a7334-d18f-4840-a540-37323dcbdada", "35efa16b-cdda-4b33-a965-7af8fabd32b4", "0e1d3777-0781-4eca-a2b4-dcb5b5cdb05f", "59ec36a5-63b9-46ff-aacd-0eec45d1a2d8"] }, // 野村全天候環球債券基金
  { sourceId: "D06CFC15-B7A2-4995-9D8E-EE5732C2AFF1::46", fundIds: ["4fe4e1de-f19e-4e81-a275-731d78e35e38", "5579216c-06d2-41b2-bafd-16a011f1d4c9", "0414cce1-1ace-4b93-8b28-420463af7c83", "2c1ee3e2-699e-4cc9-af27-b6c44037707d"] }, // 野村台灣高股息基金
  { sourceId: "6963A4D1-8D44-4768-AE3B-D7FC650D6189::14", fundIds: ["d01f44fb-ed48-4423-a41c-1e28f36ce0df"] }, // 野村全球生技醫療基金
  { sourceId: "63688F44-22BD-46F4-ACD6-231711B35139::11", fundIds: ["816abc81-c0ca-468e-bf1d-3cd51face2fb", "99216f01-3ac1-4268-875f-30d417ceccfe", "7fde1dc4-bcb1-46eb-8e74-e4893e76d0fa"] }, // 野村中國機會基金
  { sourceId: "0571D826-CE5A-4F4C-B2A9-1BC33A8FE5C2::15", fundIds: ["0e38077f-f81d-4d9c-8665-5dd62cf74f59"] }, // 野村積極成長基金
  { sourceId: "641c5bb8-d0ee-4674-a494-e358dc9ec16a::1529", fundIds: ["e00ff779-0035-4753-bc46-cadf4c847cec", "22eb38b3-df2a-457c-a97a-8cb607ff1642", "c2df94c9-2c9e-47d4-ac15-6ec8de77a541", "a1fbef5e-5cc8-4d3c-94a2-9781907f1d9b", "50713225-e1c4-4992-bdbb-759c14eb13b5", "1c8ecbc6-6829-45fe-aec4-839996be2fa8", "9122a500-ab89-4dcd-94f3-652fd2cadd62", "6a3f0e79-c1d2-48a8-a831-749212476f8e", "a100ae0c-9823-4ba7-bfbc-082cf34c6d97"] }, // 野村全球正向效應成長基金
  { sourceId: "07bd87f2-7408-4786-9a9c-5a9e355727e3::1013", fundIds: ["ed50f2af-b675-4661-9029-0c537d1397a6", "2e9cb0ec-13f6-45f9-9b14-5b78242bdbd8", "22dd5d07-7925-422c-9252-96047d7be58a", "6e529a91-e0ae-4e42-ba7d-f3160bced236", "c3523514-5478-43b3-9b18-5bf8393e34a5", "2d08db7b-d36b-46b8-af44-8b7ba8975930", "ad021625-decf-42f0-b3da-1b61b5cf7154"] }, // 野村環球非投資等級債券基金
  { sourceId: "b4bb4f5c-1985-420f-be16-c9fa6902e75f::1051", fundIds: ["10a88097-cce7-409c-a9f2-9e0e9aaceb70", "da03338e-d473-4946-bda5-2592f1ceda6b", "c370ac5a-6781-47fe-a9bb-6ce4fa87217d", "2527e73f-d9f9-45bf-83ac-c98c910de74b", "77396f5e-f2aa-43c1-9c7c-f5a0097738f0", "9dda775c-858c-4b70-8d3b-106c2213ed2c", "8b874e99-621d-4e27-83d9-44b2524ae48a", "277650df-9b98-4ff7-bb25-78d1e7b45d2c", "bbd5f07b-348a-49a3-aabb-80d701aa7ef2", "880a0630-fa1e-4b12-9d15-39fb56dd0601", "82c249fd-86f7-4245-80fe-571dd3dbb762"] }, // 野村動態配置多重資產基金
  { sourceId: "63688F44-22BD-46F4-ACD6-231711B35140::761", fundIds: ["01ea3160-6976-49d8-8b21-95b38c908891"] }, // 野村巴西基金
  { sourceId: "6F7DFABA-D4CA-46C7-84B0-BA70AB65D3B4::18", fundIds: ["c6dd236d-dc0b-4976-8ba3-20b4c00c5e49"] }, // 野村泰國基金
  { sourceId: "6D22E7E5-9BE2-4810-958F-921A2C1EB047::28", fundIds: ["f23bee23-1f5e-4336-b3c6-41bddc7558f5", "8b37554f-aaaa-416a-90a3-71a28a2d62c4", "c6a328d0-05d6-4250-bd58-0c31c62b2f31", "89e83ed5-d4df-4f42-9626-0b0c5793f26b", "2ae74808-d939-462c-a479-bb3697e802cc"] }, // 野村全球高股息基金
  { sourceId: "E39D2FF6-7692-43CD-9B94-66020D99EC36::12", fundIds: ["b49f9101-c7df-4c92-b48a-24d0386d7a1b", "4a719a32-fa46-41d0-b9ec-57e4324c8ef5", "75f365f7-b56d-47ba-904b-d8757d0d9637", "73e87bd2-4ff7-4ea2-b0ec-3537a9d21c27", "8c27660c-475f-4ed0-a9aa-d2eb0bef0c7c"] }, // 野村亞太高股息基金
  { sourceId: "06112A3B-178F-4A41-9BD0-2555BEABFC77::13", fundIds: ["7ffb3239-35fb-4283-974f-0cb6e0d52069", "d3dd39a8-d938-4dfd-84a2-ab80cada772e", "941b3812-0c41-417f-acea-7e724926c586", "a36644c0-75f1-44c7-96af-514cf626799e", "f23e64f3-50d0-460f-b291-2ed76365d993"] }, // 野村全球不動產證券化基金
  { sourceId: "A0510E3A-4627-4EB2-8ABF-A700F8E39B20::5", fundIds: ["401a9c04-c4e7-4a48-ac08-e4204996c068", "923da338-2328-41a5-b34f-8b36ee60cd5d"] }, // 野村鑫平衡組合基金
  { sourceId: "2834034A-ABAE-40AD-9FC7-6B2EAE86E694::3", fundIds: ["3ee28239-c537-42c1-a240-588f7555888c", "2db7920b-eba2-475a-8629-4cc4d378b61e"] }, // 野村平衡基金
  { sourceId: "B58154C3-0D86-449E-A5C7-8CB4D24443D2::1", fundIds: ["09578033-3195-47a0-9b11-7ec4c96aa665"] }, // 野村鴻利基金
  { sourceId: "DBADF354-0775-4F49-91AB-883D0D211190::45", fundIds: ["59554d29-5a42-44fe-9854-7cb4d827d960"] }, // 野村貨幣市場基金
];

// 國泰投信：ISIN比對（Cathay頁面的「ISIN代號」去掉TW000前綴及末位檢查碼即為SITCA CSV的
// 「受益憑證代號」，VERIFIED F01→T3701Y→17612497A、FEK→T3701A→17612497C都對得上）。
// 2026-11-03 VERIFIED：175檔裡這輪跑完143檔（逐檔點擊的SPA，背景腳本跑到時間預算上限），
// 137/143命中（96%），其餘6檔是ETF型代號（例如00636/00657這類已在etfs表範圍的ETF），正確
// 不對應、沒有猜。剩下32檔(144-175)下一輪跑完discover_cathay_isin.mjs補上即可，不用重寫
// 這支function。
export const CATHAY_FUND_MAPPINGS: IssuerFundMapping[] = [
  { sourceId: "F01", fundIds: ["1dafce6f-c52d-4ff0-9e05-9bf33a0381d8"] }, // 國泰國泰基金-新台幣A(不配息)
  { sourceId: "FEK", fundIds: ["73b23fd5-49da-4746-8cd6-3c2e99ec6f24"] }, // 國泰國泰基金-新台幣B(配息)
  { sourceId: "FEL", fundIds: ["a7e029c6-88fd-42d3-95c6-9e11a8fbcf31"] }, // 國泰國泰基金-新台幣NB(配息)
  { sourceId: "FAM", fundIds: ["f9f66366-01d5-41ff-9772-8a208df61b6d"] }, // 國泰國泰基金-新台幣I
  { sourceId: "F03", fundIds: ["c747f5e0-adbd-4e62-b77b-bb869c1393c0"] }, // 國泰中小成長基金-新台幣A(不配息)
  { sourceId: "FEM", fundIds: ["e7fa2a67-48a6-4309-b6b3-10b062cfad73"] }, // 國泰中小成長基金-新台幣B(配息)
  { sourceId: "FEN", fundIds: ["d016df94-7139-4fcd-acf0-b2842c6c47b4"] }, // 國泰中小成長基金-新台幣NB(配息)
  { sourceId: "FBF", fundIds: ["b3d53a52-c7ed-4993-bc22-357d328b5b19"] }, // 國泰中小成長基金-美元I
  { sourceId: "F06", fundIds: ["8ef5c01d-9a64-4b65-a31d-2f4c598218ee"] }, // 國泰大中華基金
  { sourceId: "F07", fundIds: ["8c9e320f-2436-4883-a0a9-b810a307eec7"] }, // 國泰科技生化基金
  { sourceId: "F14", fundIds: ["133a5eea-4800-4967-99a1-8106be6c52ff"] }, // 國泰小龍基金-新台幣A
  { sourceId: "FBG", fundIds: ["77b021fa-d921-4d61-a111-dd301f337ccb"] }, // 國泰小龍基金-美元I
  { sourceId: "FCZ", fundIds: ["99503b00-711c-4a4e-8429-942de1b535b0"] }, // 國泰小龍基金-新台幣R
  { sourceId: "FCL", fundIds: ["b1db5f0e-d46b-404b-94d1-583d987aa9f5"] }, // 國泰台灣高股息傘型基金之台灣高股息基金-新台幣A(不配息)
  { sourceId: "FCM", fundIds: ["0f76daf9-416f-46d5-a5a6-92c1506ad862"] }, // 國泰台灣高股息傘型基金之台灣高股息基金-新台幣B(配息)
  { sourceId: "FE0", fundIds: ["66261a04-4c99-4396-9d14-28fab00bb65a"] }, // 國泰台灣高股息傘型基金之台灣高股息基金-新台幣TISA
  { sourceId: "F02", fundIds: ["d3ff0908-ab5e-4bd7-9ac9-bf05e751b75b"] }, // 國泰台灣貨幣市場基金
  { sourceId: "F20", fundIds: ["82fd1d48-4df9-4b56-8083-01a8f901c83b"] }, // 國泰全球基礎建設基金-新台幣A(不配息)
  { sourceId: "FEO", fundIds: ["e2d8c5fb-e995-41bf-959a-260cc3eb6f62"] }, // 國泰全球基礎建設基金-新台幣B(配息)
  { sourceId: "FEP", fundIds: ["2e927718-7d05-431f-a42c-ca2f5606a1c7"] }, // 國泰全球基礎建設基金-新台幣NB(配息)
  { sourceId: "F54", fundIds: ["3904ed5d-e077-48bf-8b40-19f4f64f1274"] }, // 國泰全球基礎建設基金-美元A(不配息)
  { sourceId: "FEQ", fundIds: ["961247f3-f54b-493b-a867-73dac7cb6749"] }, // 國泰全球基礎建設基金-美元B(配息)
  { sourceId: "FER", fundIds: ["db59bcf0-2ddd-4ee1-abd9-fa8f9d35b6e1"] }, // 國泰全球基礎建設基金-美元NB(配息)
  { sourceId: "F26", fundIds: ["01516dd3-ef47-4bc1-83fe-1ec24ebad358"] }, // 國泰中港台基金-新台幣
  { sourceId: "F57", fundIds: ["32a0a489-d8f0-4804-a6b2-ce4f8a99643a"] }, // 國泰中港台基金-美元
  { sourceId: "FAG", fundIds: ["8c35c9bd-79af-4b96-9185-1b0c7239cec2"] }, // 國泰中港台基金-人民幣
  { sourceId: "F28", fundIds: ["e4f8a54a-84b4-41ef-9d40-1eb3358ca62c"] }, // 國泰新興市場基金-新台幣
  { sourceId: "FAB", fundIds: ["b63c9e6a-91dd-404e-9424-a3569874c4b8"] }, // 國泰新興市場基金-美元
  { sourceId: "F31", fundIds: ["59c7bdea-4a9e-4080-8230-5d0aee644c28"] }, // 國泰中國內需增長基金-新台幣
  { sourceId: "F53", fundIds: ["42603d5e-ffea-48b6-9531-e687f6dd39c0"] }, // 國泰中國內需增長基金-美元A
  { sourceId: "F64", fundIds: ["84af0e24-8562-43c6-8418-a30a713ecc7d"] }, // 國泰中國內需增長基金-美元I
  { sourceId: "FAH", fundIds: ["78db54a6-4b59-46ae-820b-190e46958836"] }, // 國泰中國內需增長基金-人民幣
  { sourceId: "F34", fundIds: ["73e9124d-9098-4dec-87eb-1b10fb127241"] }, // 國泰中國新興戰略基金-新台幣
  { sourceId: "F73", fundIds: ["d7b3f51b-406d-4cdd-bcf9-14b8f8928069"] }, // 國泰中國新興戰略基金-美元
  { sourceId: "FAI", fundIds: ["b325c76b-4e7c-4eee-b777-87b453195d75"] }, // 國泰中國新興戰略基金-人民幣
  { sourceId: "F55", fundIds: ["5fe09b75-504b-41b2-ae54-eaedab656fa2"] }, // 國泰亞洲成長基金-新台幣
  { sourceId: "F56", fundIds: ["194905a6-cbcb-4ad3-a380-6262a70c2aa9"] }, // 國泰亞洲成長基金-美元
  { sourceId: "FDA", fundIds: ["47fd1308-23d8-471d-bf5e-c454c7ffcf3a"] }, // 國泰亞洲成長基金-人民幣
  { sourceId: "FDB", fundIds: ["784b701c-f8a7-4f59-8a85-440a7a4e18d6"] }, // 國泰亞洲成長基金-澳幣
  { sourceId: "FCX", fundIds: ["c71b4497-2695-4401-9cf5-377ad7d4dd72"] }, // 國泰美國ESG基金-新台幣
  { sourceId: "FCY", fundIds: ["a5abc900-0e65-44e9-a920-8be8073056a1"] }, // 國泰美國ESG基金-美元
  { sourceId: "F46", fundIds: ["2df5d052-5a08-451f-a340-381a7e009f10"] }, // 國泰收益傘型基金之全球多重收益平衡基金-新台幣A(不配息)
  { sourceId: "F47", fundIds: ["0619c6ac-9723-45f6-9413-4346f3c6cfc5"] }, // 國泰收益傘型基金之全球多重收益平衡基金-新台幣B(配息)
  { sourceId: "FD2", fundIds: ["a60f543d-017b-49d9-a780-071ac0bc0dd3"] }, // 國泰收益傘型基金之全球多重收益平衡基金-新台幣R(不配息)
  { sourceId: "F48", fundIds: ["f6acdf30-332b-4d31-82c4-d7469d7da3f8"] }, // 國泰收益傘型基金之全球多重收益平衡基金-美元A(不配息)
  { sourceId: "F49", fundIds: ["ef352707-f214-4870-837e-1b482239034a"] }, // 國泰收益傘型基金之全球多重收益平衡基金-美元B(配息型)
  { sourceId: "F65", fundIds: ["f7557fa0-5f45-49f4-ab77-8ae24d6230dc"] }, // 國泰收益傘型基金之全球多重收益平衡基金-美元I(不配息)
  { sourceId: "F81", fundIds: ["b7c26a0c-4c8e-4116-851e-27dc837e3a8d"] }, // 國泰收益傘型基金之全球多重收益平衡基金-澳幣A(不配息)
  { sourceId: "F75", fundIds: ["6c7ad86c-e41a-42cd-a1cb-f06475d9603b"] }, // 國泰亞太入息平衡基金-新台幣A(不配息)
  { sourceId: "F76", fundIds: ["66e19910-0b14-434c-a9a1-4018314d2192"] }, // 國泰亞太入息平衡基金-新台幣B(配息)
  { sourceId: "F77", fundIds: ["5af1e962-72c4-4b57-bb33-e7f6e6f73191"] }, // 國泰亞太入息平衡基金-美元A(不配息)
  { sourceId: "F78", fundIds: ["9f6b0644-5da6-4659-a329-0a03bdc838b6"] }, // 國泰亞太入息平衡基金-美元B(配息)
  { sourceId: "F79", fundIds: ["60f2684c-d1c2-4639-b96a-f9f21a1ce039"] }, // 國泰亞太入息平衡基金-人民幣A(不配息)
  { sourceId: "F80", fundIds: ["4a92a43a-31f7-4831-b9b7-6de901806b1a"] }, // 國泰亞太入息平衡基金-澳幣A(不配息)
  { sourceId: "FC3", fundIds: ["07c92626-a815-4047-9e93-9ac38946d784"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-新台幣A(不配息)
  { sourceId: "FC4", fundIds: ["d7609e70-676b-4b34-8c4f-499776ceb65b"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-新台幣B(配息)
  { sourceId: "FC5", fundIds: ["733b4b0c-7be2-46cb-a644-69191333e9d0"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-新台幣NB(配息)
  { sourceId: "FC6", fundIds: ["40d964a1-beca-4a7e-b36b-27e16b3699fe"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-美元A(不配息)
  { sourceId: "FC7", fundIds: ["06ece7bd-9040-4329-bcd1-3373adee78e2"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-美元B(配息)
  { sourceId: "FC8", fundIds: ["fd7487a1-0ceb-47ee-a6f6-3a7aea9ee76d"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-美元NB(配息)
  { sourceId: "FDU", fundIds: ["920a3b3f-9cc5-4c5f-aa49-a75b410a8deb"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-日圓B(配息)
  { sourceId: "FC9", fundIds: ["56d55742-40a4-4ea2-8eb9-60b67b9b03e8"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-人民幣B(配息)
  { sourceId: "FCA", fundIds: ["5f0d4d07-923a-4bfa-94b2-ae4d244f314d"] }, // 國泰美國收益傘型基金之美國多重收益平衡基金-南非幣B(配息)
  { sourceId: "F32", fundIds: ["690d3c0f-a916-4501-9a3b-9d8c8ff88b83"] }, // 國泰新興非投資等級債券基金-新台幣A(不配息)
  { sourceId: "F33", fundIds: ["d46d4dd2-f298-41f7-875d-73cc6a750665"] }, // 國泰新興非投資等級債券基金-新台幣B(配息)
  { sourceId: "F59", fundIds: ["f1a661fb-9aa7-463f-a0b3-ba756fa2357e"] }, // 國泰新興非投資等級債券基金-美元A(不配息)
  { sourceId: "F60", fundIds: ["7dddbfa3-92b3-420f-babd-14af08aa8316"] }, // 國泰新興非投資等級債券基金-美元B(配息)
  { sourceId: "F63", fundIds: ["e66e1358-e3e5-4bd0-84f0-2e6442c75b3b"] }, // 國泰新興非投資等級債券基金-美元I(不配息)
  { sourceId: "F61", fundIds: ["6fcc0831-25a6-40b5-8cf9-602f6990c08b"] }, // 國泰新興非投資等級債券基金-人民幣A(不配息)
  { sourceId: "F62", fundIds: ["4e9972ec-bb8f-4b11-afdd-842aa1bd3173"] }, // 國泰新興非投資等級債券基金-人民幣B(配息)
  { sourceId: "FAN", fundIds: ["394cf311-4437-4bc3-bb4d-1e5aee9a63d7"] }, // 國泰優勢收益傘型基金之主順位資產抵押非投資等級債券基金-新台幣A(不配息)
  { sourceId: "FAO", fundIds: ["38def503-2da9-4557-a4b9-2d6c7f77b174"] }, // 國泰優勢收益傘型基金之主順位資產抵押非投資等級債券基金-新台幣B(配息)
  { sourceId: "FAP", fundIds: ["dd663ae5-5f6e-48cd-b98a-8f3bdc92ea49"] }, // 國泰優勢收益傘型基金之主順位資產抵押非投資等級債券基金-新台幣NB(配息)
  { sourceId: "FAQ", fundIds: ["daad84b3-44a5-4a15-9f2f-b98ea75b83ba"] }, // 國泰優勢收益傘型基金之主順位資產抵押非投資等級債券基金-美元A(不配息)
  { sourceId: "FAR", fundIds: ["10f3bfae-6b56-406b-9c52-b19d8a6cf4c3"] }, // 國泰優勢收益傘型基金之主順位資產抵押非投資等級債券基金-美元B(配息)
  { sourceId: "FAS", fundIds: ["ee5aaad1-6295-4a02-b784-fa108308ad33"] }, // 國泰優勢收益傘型基金之主順位資產抵押非投資等級債券基金-美元NB(配息)
  { sourceId: "FCD", fundIds: ["297b6d05-894b-4ccf-9726-721e9ddae77e"] }, // 國泰亞洲非投資等級債券基金-新台幣A(不配息)
  { sourceId: "FCE", fundIds: ["f2d84b62-d62f-4d2c-9acd-f08d3dee3530"] }, // 國泰亞洲非投資等級債券基金-新台幣B(配息)
  { sourceId: "FCF", fundIds: ["a03d8860-aebe-4b71-bd10-1cdae7b3796c"] }, // 國泰亞洲非投資等級債券基金-新台幣NB(配息)
  { sourceId: "FCG", fundIds: ["f1c87f41-38ab-47a5-97d4-6a7342651538"] }, // 國泰亞洲非投資等級債券基金-美元A(不配息)
  { sourceId: "FCH", fundIds: ["dc634687-7667-43d8-a8d8-3cc649efac34"] }, // 國泰亞洲非投資等級債券基金-美元B(配息)
  { sourceId: "FCI", fundIds: ["ead51d08-b68e-4484-bf84-8cb41dda8554"] }, // 國泰亞洲非投資等級債券基金-美元NB(配息)
  { sourceId: "FDG", fundIds: ["c34c23a0-d33c-4d3c-a591-ad3433962e8a"] }, // 國泰美國優質債券基金-新台幣A(不配息)
  { sourceId: "FDH", fundIds: ["b19f7df9-76a4-48e2-93b7-9e3e5f14327c"] }, // 國泰美國優質債券基金-新台幣B(配息)
  { sourceId: "FDW", fundIds: ["3df74dfd-b445-4f22-a461-b3982024dc6a"] }, // 國泰美國優質債券基金-新台幣NB(配息)
  { sourceId: "FDI", fundIds: ["74acf2f7-ebe3-47f4-94d4-7e15816fc1a4"] }, // 國泰美國優質債券基金-美元A(不配息)
  { sourceId: "FDJ", fundIds: ["ec59c96b-90d6-4132-a12e-9a1d414ac6ea"] }, // 國泰美國優質債券基金-美元B(配息)
  { sourceId: "FDX", fundIds: ["fbb8074c-0f41-441f-95c3-c48794defe09"] }, // 國泰美國優質債券基金-美金NB(配息)
  { sourceId: "FDV", fundIds: ["8703ca44-8a85-4597-b04c-77138c996382"] }, // 國泰美國優質債券基金-日圓B(配息)
  { sourceId: "FDK", fundIds: ["cf1995fe-85c2-44fa-ae91-9f328d5197e9"] }, // 國泰四年到期成熟市場投資等級債券基金-新台幣A(不配息)
  { sourceId: "FDL", fundIds: ["487d26ff-ec4b-41a8-b85f-aad03668dd7d"] }, // 國泰四年到期成熟市場投資等級債券基金-新台幣B(配息)
  { sourceId: "FDM", fundIds: ["efc39d22-860c-4cd1-9dda-907139849e20"] }, // 國泰四年到期成熟市場投資等級債券基金-美元A(不配息)
  { sourceId: "FDN", fundIds: ["d3fe3434-efab-410b-b601-30798670061d"] }, // 國泰四年到期成熟市場投資等級債券基金-美元B(配息)
  { sourceId: "F45", fundIds: ["cd2b768c-6ded-47ea-9eaf-7c361ed4fab9"] }, // 國泰人民幣貨幣市場基金-美元
  { sourceId: "F40", fundIds: ["17dc2c19-ab91-48a7-8cd2-78aa75112c1c"] }, // 國泰人民幣貨幣市場基金-人民幣
  { sourceId: "F15", fundIds: ["810b92db-4d8f-434f-846e-30ebb286ddc2"] }, // 國泰幸福階梯傘型基金之全球積極組合基金-新台幣A(不配息)
  { sourceId: "FBC", fundIds: ["a0066fb0-56c2-460d-aaa8-a936823dee06"] }, // 國泰幸福階梯傘型基金之全球積極組合基金-新台幣B(配息)
  { sourceId: "FD0", fundIds: ["2fdb6046-266c-4809-a197-9090027c47e9"] }, // 國泰幸福階梯傘型基金之全球積極組合基金-新台幣R(不配息)
  { sourceId: "F51", fundIds: ["a665e7dd-3370-4e11-ab22-586290911f11"] }, // 國泰幸福階梯傘型基金之全球積極組合基金-美元A(不配息)
  { sourceId: "FBD", fundIds: ["eb955a24-a2fb-4798-bc1f-b936a2d507e0"] }, // 國泰幸福階梯傘型基金之全球積極組合基金-澳幣A(不配息)
  { sourceId: "F27", fundIds: ["79870f2f-b6a5-4679-9d93-17bd66145590"] }, // 國泰豐益債券組合基金-新台幣A(不配息)
  { sourceId: "FD8", fundIds: ["d4b3c36b-e268-454b-9b44-885bc3d64912"] }, // 國泰豐益債券組合基金-新台幣B(配息)
  { sourceId: "FD1", fundIds: ["5b86a5eb-94c7-4537-9342-03a7bff49d0f"] }, // 國泰豐益債券組合基金-新台幣R(不配息)
  { sourceId: "FAF", fundIds: ["b8dfc877-8588-4ac7-97f6-0ce42a3fb5f3"] }, // 國泰豐益債券組合基金-美元A(不配息)
  { sourceId: "FD9", fundIds: ["a9ffb561-dadf-4a59-bf26-973ab0a0644a"] }, // 國泰豐益債券組合基金-澳幣A(不配息)
  { sourceId: "FBT", fundIds: ["278125c8-a127-4c3c-bd4f-950ca2fa50d2"] }, // 國泰泰享退系列2029目標日期組合基金-新台幣A
  { sourceId: "FBV", fundIds: ["87f199b7-dfe4-4d0d-8922-41f89e5e93be"] }, // 國泰泰享退系列2029目標日期組合基金-新台幣P
  { sourceId: "FD3", fundIds: ["ddbbc08a-4b70-4afb-849e-bb87097d93d4"] }, // 國泰泰享退系列2029目標日期組合基金-新台幣R
  { sourceId: "FBU", fundIds: ["4cc26884-5aec-4da4-ad3f-279a76720587"] }, // 國泰泰享退系列2029目標日期組合基金-美元A
  { sourceId: "FBW", fundIds: ["bde1bd5c-4788-475a-971c-6e3723ce0ddc"] }, // 國泰泰享退系列2039目標日期組合基金-新台幣A
  { sourceId: "FBY", fundIds: ["dabde616-e52a-4455-8abd-b58c76b897a1"] }, // 國泰泰享退系列2039目標日期組合基金-新台幣P
  { sourceId: "FD4", fundIds: ["0881d092-99cb-438f-b1d8-651cbd591478"] }, // 國泰泰享退系列2039目標日期組合基金-新台幣R
  { sourceId: "FBX", fundIds: ["003814d0-1714-4f5e-bfac-25822132dc3c"] }, // 國泰泰享退系列2039目標日期組合基金-美元A
  { sourceId: "FBZ", fundIds: ["bac5fa4c-a16e-4f66-9bd3-edd5dbe85864"] }, // 國泰泰享退系列2049目標日期組合基金-新台幣A
  { sourceId: "FDZ", fundIds: ["fcbbb41f-2f74-46ce-abbe-0784e58ed0b4"] }, // 國泰泰享退系列2049目標日期組合基金-新台幣TISA
  { sourceId: "FC1", fundIds: ["ca4cad55-9143-409d-ac10-e9ba20ef143c"] }, // 國泰泰享退系列2049目標日期組合基金-新台幣P
  { sourceId: "FD5", fundIds: ["6bd9b04b-1d8c-4f9b-9307-ddddcb083701"] }, // 國泰泰享退系列2049目標日期組合基金-新台幣R
  { sourceId: "FC0", fundIds: ["e7d6b177-1086-460e-adc7-f1c8d5fb8826"] }, // 國泰泰享退系列2049目標日期組合基金-美元A
  { sourceId: "FEC", fundIds: ["36e902ef-ed59-44a2-b152-988a398daec2"] }, // 國泰全球多元收益傘型基金之環球策略收益債券基金-新台幣A(不配息)
  { sourceId: "FED", fundIds: ["70a6de5b-9a3e-4f39-b041-0030192da192"] }, // 國泰全球多元收益傘型基金之環球策略收益債券基金-新台幣B(配息)
  { sourceId: "FEE", fundIds: ["4c2326b5-54d2-4978-a4d2-071390ca8af1"] }, // 國泰全球多元收益傘型基金之環球策略收益債券基金-新台幣NB(配息)
  { sourceId: "FEF", fundIds: ["84d61719-d1f6-46e9-944c-e7b230e1d8ff"] }, // 國泰全球多元收益傘型基金之環球策略收益債券基金-美元A(不配息)
  { sourceId: "FEG", fundIds: ["928f17db-fd20-41b5-94e8-c83b518c4c60"] }, // 國泰全球多元收益傘型基金之環球策略收益債券基金-美元B(配息)
  { sourceId: "FEH", fundIds: ["b13f5a05-2dcf-41ed-b74e-72621d51a355"] }, // 國泰全球多元收益傘型基金之環球策略收益債券基金-美元NB(配息)
  { sourceId: "FEI", fundIds: ["7bf7f5e2-c680-4974-a9c9-3ca4847387d7"] }, // 國泰全球多元收益傘型基金之環球策略收益債券基金-日圓B(配息)
  { sourceId: "FEJ", fundIds: ["9d0f42a7-b486-4f39-944f-03e4ea07385d"] }, // 國泰全球多元收益傘型基金之環球策略收益債券基金-日圓NB(配息)
  { sourceId: "E82", fundIds: ["39edc11b-b1f8-4734-a374-377cafb37d91"] }, // 國泰A50傘型基金之富時中國A50單日正向2倍基金
  { sourceId: "E83", fundIds: ["c58e89de-835e-4a56-8ae6-1045a6518cfd"] }, // 國泰A50傘型基金之富時中國A50單日反向1倍基金
  { sourceId: "E87", fundIds: ["aa1a671e-1b7b-4bbd-b930-9f39ecd661ab"] }, // 國泰臺指ETF傘型基金之臺灣加權指數單日正向2倍基金
  { sourceId: "E88", fundIds: ["eee41df3-d69c-462a-9d58-6aa2555b3da1"] }, // 國泰臺指ETF傘型基金之臺灣加權指數單日反向1倍基金
  { sourceId: "E94", fundIds: ["4f550256-cf4a-4a1c-a3a3-d107c5ad0e70"] }, // 國泰美國ETF傘型基金之道瓊工業平均指數單日反向1倍基金
  { sourceId: "EA8", fundIds: ["d759e1be-a97f-493d-a1c6-cdb1a5b81282"] }, // 國泰美國債券ETF傘型基金之20年期(以上)美國公債指數基金-新台幣(配息)
  { sourceId: "EDY", fundIds: ["8ae36cdc-e0d2-4214-a6a3-4bab4541f683"] }, // 國泰美國債券ETF傘型基金之20年期(以上)美國公債指數基金-美元(不配息)
  { sourceId: "EA9", fundIds: ["2be35d99-f747-4a7d-8761-886fec99374b"] }, // 國泰美國債券ETF傘型基金之20年期(以上)美國公債指數單日正向2倍基金
  { sourceId: "EAA", fundIds: ["b4d831e9-4a65-4e2d-89e7-3ec91926c63f"] }, // 國泰美國債券ETF傘型基金之20年期(以上)美國公債指數單日反向1倍基金
  { sourceId: "EAJ", fundIds: ["32187024-7221-4ffa-83de-deb4108cba5d"] }, // 國泰息收ETF傘型基金之10年期(以上)BBB美元息收公司債券基金
  { sourceId: "EAK", fundIds: ["9166b628-c62f-435e-a3ae-d69fbca61421"] }, // 國泰息收ETF傘型基金之新興市場5年期(以上)美元息收投資等級債券基金
];

// 群益投信（capitalfund.com.tw）、富邦投信（fubon.com）：這輪新增解析器並各自dry-run驗證2檔
// （群益：群益馬拉松基金fundNo=003股票型、群益安穩貨幣市場基金fundNo=002貨幣市場型；富邦：
// 富邦基金-A類型Fd=01A、富邦精準基金Fd=04，皆逐列核對跟官網頁面一致），但完整基金清單→
// funds.id對應表這輪沒做（群益的fundNo、富邦的Fd代號都要從官網選單清單頁逐一點進去才查得到，
// 跟元大/國泰同樣問題），先留空陣列，下一輪比照元大/國泰的作法做完整清單。
export const CAPITAL_FUND_MAPPINGS: IssuerFundMapping[] = [];
export const FUBON_FUND_MAPPINGS: IssuerFundMapping[] = [];
