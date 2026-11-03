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
  // 2026-11-03：剩餘32檔(index 143-175)的後續比對——FE1~FE8是兩檔新基金(國泰全球多重收益平衡、
  // 國泰主順位資產抵押非投資等級債券)，funds表isin欄位是null，無法靠ISIN比對，改用幣別+配息
  // 類別(C/NC)對名稱比對，VERIFIED一對一無歧義。其餘24檔(EAL~EEB，00xxx代號)是在證交所掛牌交易
  // 的指數化ETF，不是「傘型基金之XX基金」這種仍在funds表內的子基金結構，funds表查無對應列
  // （非匹配失敗，是這些ETF本來就不屬於這張對應表要接的「投信月報持股」資料範圍）。
  { sourceId: "FE1", fundIds: ["75bd5cf1-e90e-470e-83e5-d92967ef2e8d"] }, // 國泰全球多重收益平衡基金-新台幣C(配息)
  { sourceId: "FE2", fundIds: ["1a1f37f3-dfc3-4560-a970-39a981590021"] }, // 國泰全球多重收益平衡基金-新台幣NC(配息)
  { sourceId: "FE3", fundIds: ["e5bd6e66-1be4-4785-9edc-b7d421baa10f"] }, // 國泰全球多重收益平衡基金-美元C(配息)
  { sourceId: "FE4", fundIds: ["034a8ac6-b81e-44a9-a558-74a0aa665ab9"] }, // 國泰全球多重收益平衡基金-美元NC(配息)
  { sourceId: "FE5", fundIds: ["85f364e6-6559-435b-b9c5-7a3481631cd2"] }, // 國泰主順位資產抵押非投資等級債券基金-新台幣C(配息)
  { sourceId: "FE6", fundIds: ["f8234b75-cde0-4872-a70c-22bd70cf0257"] }, // 國泰主順位資產抵押非投資等級債券基金-新台幣NC(配息)
  { sourceId: "FE7", fundIds: ["cde70ed0-0ba0-4cf9-b828-aabc8b3dac4e"] }, // 國泰主順位資產抵押非投資等級債券基金-美元C(配息)
  { sourceId: "FE8", fundIds: ["c3d24b5d-cfb8-49fc-9ee1-d6edfb4d5987"] }, // 國泰主順位資產抵押非投資等級債券基金-美元NC(配息)
];

// 群益投信（capitalfund.com.tw）：官網「基金總覽」頁本身就是一支JSON API（GET /CFWeb/api/
// fund/overview）一次回傳全部261檔(含ETF)，不用逐檔點擊——比元大/國泰快很多。排除isETF=true後
// 剩233檔share class、39個基金家族，用SITCA CSV（公司名稱=群益投信）精確比對基金層級名稱。
// 2026-11-03 VERIFIED：27/39個基金家族命中（69%），0筆ambiguous；其餘12家NO_MATCH（名稱
// 在官網跟SITCA之間有額外差異，例如"群益2028 REVERSO美元保本基金"這類特殊命名），正確不
// 對應、沒有猜，下一輪可以individually核對。
export const CAPITAL_FUND_MAPPINGS: IssuerFundMapping[] = [
  { sourceId: "003", fundIds: ["76b2f5f8-0807-428b-b73a-c26367c1cda5", "77590979-14dc-4923-af34-9849702085e5", "2ed47ecd-bf31-4b32-816c-ecdc1d2a8eac"] }, // 群益馬拉松基金
  { sourceId: "005", fundIds: ["9d6e196d-c0fa-473c-ba32-c0bd7a048609"] }, // 群益長安基金
  { sourceId: "007", fundIds: ["b60c9eb0-68b5-4b5a-9009-f7a8a9a8433c", "819fbdb8-8252-40d3-9cfe-d93eaf720221"] }, // 群益創新科技基金
  { sourceId: "001", fundIds: ["0d46c9b3-8cf7-4841-81ea-39c4e4c1d440"] }, // 群益中小型股基金
  { sourceId: "002", fundIds: ["ad83e1f6-4c91-4032-83f9-880be1335579"] }, // 群益安穩貨幣市場基金
  { sourceId: "004", fundIds: ["402b6af2-5c92-4280-8505-f15f5c87692f", "5cbc5930-a854-439f-9b6e-7b7d9554e5e5"] }, // 群益店頭市場基金
  { sourceId: "008", fundIds: ["531ffbcd-4175-40a5-9ec1-6c91a180e922"] }, // 群益真善美基金
  { sourceId: "011", fundIds: ["d01932dd-698c-4537-b7b8-5f9464e74a14"] }, // 群益平衡王基金
  { sourceId: "013", fundIds: ["dd88052c-ef5d-43e6-aa0c-1dfd717449da"] }, // 群益安家基金
  { sourceId: "014", fundIds: ["7f6c66fd-f3cf-4393-b21b-a3e974b0c723"] }, // 群益多重資產組合基金
  { sourceId: "015", fundIds: ["71107b4b-1347-49d4-9037-a0d03bac7f10"] }, // 群益奧斯卡基金
  { sourceId: "017", fundIds: ["93296ae0-350c-4c46-9487-7f689eb57a96"] }, // 群益葛萊美基金
  { sourceId: "018", fundIds: ["c121591e-46b4-4ebe-ab83-7b4d109df057"] }, // 群益亞太新趨勢平衡基金
  { sourceId: "019", fundIds: ["8b952733-4e05-47a8-a613-2c00d7f54728", "b842dba7-4ab7-4d5c-b06b-a9e117e56a70"] }, // 群益新興金鑽基金
  { sourceId: "022", fundIds: ["e77d834a-dea8-4c4c-aca1-e0f438ecc4f8", "daa3a517-3faa-400a-9bff-3b1cebedaf25", "9d691898-e13a-4e6a-9587-e44960726988"] }, // 群益東方盛世基金
  { sourceId: "023", fundIds: ["5d6c994e-b778-4087-9d53-487a4c4ed981", "6474ae79-64ea-404a-b7ae-ffcf5bc6b875", "5362e72d-2735-4650-a6b5-b9bf7a789199", "80954a85-e6c7-4066-a040-8aa1a07427a9", "59360d1e-360b-4f32-abaf-7e01bbb4ff67", "8d2c9b0e-b955-4738-af3b-f85a91e9325a"] }, // 群益華夏盛世基金
  { sourceId: "024", fundIds: ["c3e4581e-bb32-4510-a826-bb4c2f3e5e65", "cb8f9485-29a0-41bd-bf53-2e87a800e244"] }, // 群益印巴雙星基金
  { sourceId: "074", fundIds: ["9f733b00-bff6-4466-b84b-d0410105070d", "8ef76350-9c52-42f1-bc87-7bb543ec107d", "c371c8ec-a904-4141-9b98-f29448bf8fef", "46fd25d6-bccb-46f8-912c-a455c37f465f", "b09db1cb-5776-4b48-a227-c7d46f8784c0", "2b50f0dc-3439-4ec3-b4d5-5a019e89f104"] }, // 群益印度中小基金
  { sourceId: "027", fundIds: ["58eb07d9-065f-489e-a411-7e0b224df8e0", "46df6602-26ad-454e-a8fc-a681b86b5daf", "0f8b1c0e-bbe3-440b-bd47-6749d945970b"] }, // 群益東協成長基金
  { sourceId: "030", fundIds: ["6fd97f10-b774-481f-910a-6e376bb167ec", "7ea8aee6-9e85-42cf-8e6f-25fafb47c408", "5ecfbf6d-0736-44d9-8927-e12171d19356"] }, // 群益大中華雙力優勢基金
  { sourceId: "036", fundIds: ["88f22536-b3ec-4969-8218-8108528ce99f", "b78ca78d-0652-473d-9def-1df26124cc0c", "9a9fbed8-c218-4875-b006-099aa21bffa9", "e24d2d5f-7869-443b-a0e7-4ab1c4990942"] }, // 群益全球關鍵生技基金
  { sourceId: "038", fundIds: ["bf8ca7a4-d892-4fdf-bf7d-143ff1361219", "7ae40481-f5d1-4d28-8df0-7e12e139fcdf", "0de7a24a-42c0-4317-8778-59bfe722ff2c", "bff3e8c9-94c4-4071-bf27-0dc30876ddc5"] }, // 群益美國新創亮點基金
  { sourceId: "040", fundIds: ["1822d386-8bf5-49ea-b9f3-9e2eed6b8b44", "3cb88055-248c-4233-929c-7f280ddcbf31", "2d6dfad9-28d8-450e-b083-b6cb28a9637f", "931e3cd4-5e7f-481b-9e82-70b3a204810c", "28ef479c-38af-4a6d-92fa-0f2bd456ce31", "3e6383bd-17b2-44c5-8fa2-d6ffbf749840"] }, // 群益中國新機會基金
  { sourceId: "359", fundIds: ["75c2aa94-6376-4d4a-95c1-60eee55c186a", "f6505ad9-fab4-43c3-9a7b-076ccb2baf45", "456b2bff-3388-4e93-822a-6b86a6779560", "807b7a5d-1ed4-4ff1-8254-76e12db965ac", "1682cccb-58d4-4879-8444-a76150b0a93e", "4738d2d5-69f2-44be-811d-fab56eeb41f3"] }, // 群益智慧聯網電動車基金
  { sourceId: "077", fundIds: ["cba0089a-57b4-4153-af7b-1c0d7daef4bd", "9e31a784-2629-451f-8e02-c1c1fb690665", "c1b0245b-55d9-4598-be68-fe95d6f86e2f", "dd8d50ad-8aa0-49d8-b0f1-2b718d58c2af", "c4cbd10d-8aa3-463f-a732-20f72653610e", "dadba275-aade-44d7-aa9b-71f5d4d794ee"] }, // 群益大印度基金
  { sourceId: "158", fundIds: ["89ae9678-9720-4cb2-84bb-ce0799526831", "02d9eaac-efaa-4d38-80f6-51a329ba837d", "59ac0899-24ef-4d54-b279-a20d38208cdc", "ed2728d3-6f01-4b00-a002-f8b9ec29901e", "b107f8f6-815a-44ce-aa61-e77863cf731a", "eb82cb26-b704-4000-8311-134f9334d214", "403b6607-32f4-4c04-9997-b33fc712948a", "82e97920-0f23-4ba3-8dc1-f234df118d33", "cec48415-2425-430b-aa47-001ca135ee90", "964b2332-05ab-4330-8c87-d33fb521dd6f", "614b1c9f-b64e-4f5d-ac95-f4cecaedc504", "a8d77073-c1a0-4589-ae3a-8750f0d28696", "7f302b93-19f1-4941-8fad-26c2cdf30d9d"] }, // 群益全球優先順位非投資等級債券基金
  { sourceId: "174", fundIds: ["a5bc2513-b8ef-4704-b560-4f73e7e72e9a"] }, // 群益2028 REVERSO美元保本基金

// 2026-11-04：剩餘14檔用跟台新同一套「去幣別/級別後綴，基金層級名稱比對」規則補完
// (lib/cloud-ingestion/issuerFundMappings.ts的baseName規則)，0歧義、全部對到。
  { sourceId: "321", fundIds: ["e64cf631-4ded-4ac1-9343-0e92f7aa8747", "1e51b3e4-16fd-4ce2-a479-f437a750f1d5", "6036dd3f-8feb-493e-82f1-ed50dd6f36d3", "f954c535-50e3-4321-b571-5adaea2c2ed0", "0d72a377-5922-4907-90fb-2a1ec2c21ec9", "d6179809-8f49-438d-8b8f-93d26d9243b3", "b172d823-5093-44be-9b64-03f1c03c2c28", "a027348e-5535-4268-aea8-8576fbb1a6bc", "00f0d0cb-08ad-4421-9684-f7ada894658b"] }, // 群益全民安穩樂退組合基金
  { sourceId: "322", fundIds: ["bba83a41-1423-4a62-936e-ae16c5222cb6", "a82e9891-acfa-4e08-be19-9d22dd452407", "0abf5da5-af37-4a3d-b4cb-1b26a545005b", "4020c6d1-71fb-4c5a-af39-39fa8dd2471c", "55aac010-0044-48b5-9586-a99490eb22d7", "2ed73c4c-2be8-4b36-b207-ecc730270a16", "c0a23bfa-b247-479c-bd04-cf981a91c232", "dc1d1386-ecc9-4e0c-9060-77f95e985d2c", "5fc98054-9c56-4e3d-b8cc-f08de14c09f3", "8416ceae-5d52-45a9-9f56-9c401cb59d89", "66bad163-7463-4200-8e1e-c15c8b913584", "445c1433-1e23-485d-aa9b-b37f6636841f", "d43c04d7-1e62-43f3-960a-9a972fe8b732", "445c84cd-6fa3-47bb-bf14-30e458a05498", "1a0aacb6-0564-49d7-8a25-d2a24f33e47b", "b6cc49bb-659a-490f-a6b1-b4b058059056", "94d3349b-e709-4234-871c-f681f41f1c3d", "09224967-5345-41ce-9aff-347727f245b4", "3e31123f-cdf3-459b-a1a8-bc4f15b1ca60", "7051a2a9-b9d1-4d69-a091-702ec31ba621", "8fb58521-8396-4e39-9bac-370c3fa10b94", "31b7e235-6620-4125-9a62-dae1d0af73cc", "1bc81b03-1580-46da-9c7a-0c807b7a4109", "31e9f1f4-e58a-4204-8399-04f544caed65", "4a3ff070-a209-45df-892e-5904cee0954a", "bd7a7176-9d15-4741-afe0-eaf477d5b20d"] }, // 群益全球策略收益金融債券基金
  { sourceId: "051", fundIds: ["a76f9b90-506c-410d-882d-bf5d6de26ab8", "124ddf27-e60f-4340-b27f-d7fa34f7a9cc", "1cf33c80-d2ab-490f-b8ed-85d0e8a52395", "097a3f1f-9d41-4b15-ae99-95e79adb233b", "55a5641f-fb13-4040-bdbe-685d6ded0fda", "13857fcc-2a87-4795-991d-252f267d28e6", "2b12aec7-3091-4ac4-9e59-c5e5399cff30", "b90c1c9a-02fd-4869-bb1a-bd0ef1fe37e6", "9ae54884-c9c0-4f30-96ab-804a7e0de1c2", "3fa6e5b4-7793-4ba6-bc79-a977d8dd9976", "30860f56-2ee4-407c-9884-cbaf6bc1e5b4", "2fe1de35-dade-4476-b1bf-5072b6646bcd", "391c5688-4588-44bf-9280-14128c389f32", "af7f7052-d0f2-47da-9ec0-ffc17f1feb08", "7089711d-abe2-4cab-8e52-6c523dd840af", "fbddef6b-b114-41ca-ae7e-77f80f67ecde", "47e93331-1220-4901-aebc-7ac6db83ffcc", "4a4c3e89-bc23-49f8-83e3-8f2e5ea80185", "63015a41-8b96-4f9c-b60c-7ffea3348d01", "547b35ac-0d5e-4119-8f4a-d0e367e9ae7b", "8880c852-8bfa-41c8-adba-d77422c2f7b0", "38a4ee7d-b864-49d9-bad1-3fdae400e2de", "07a031a2-dc9b-42f1-b1e5-e1a39b2dabf4", "b0329c68-79f3-477d-8aea-39768ca20bac", "0dc6286b-7c91-4024-bf28-f4dfa9029d73", "8f35e945-b443-4d80-9130-7322e117bfae", "38442213-b7bf-405d-80ae-04a32512b7e3", "cfb446fa-6b68-4874-9652-8b2ddb8e6bc5", "8423dc32-e2e9-4422-8957-34fbf3c9b778", "6430a032-5a8b-47be-90b1-37ed890ca727", "a37966a7-e775-45c5-a3cf-da74d70f95fd", "df370f4d-90ca-44d6-9980-2dbddbc82a7d", "c68f4c20-ea3d-414a-88b1-3a09373efe09", "0508cf5e-6e27-4424-9cee-ea85d0eb9284", "cb4cae41-276a-4de3-bc8b-7c2141658a6a", "d76b7672-972d-4654-8fb6-693e7555a412", "7b686622-b996-4733-8df5-1a4b1038fca6", "b59aac40-2184-46ea-bfea-50b41aad25f9"] }, // 群益環球金綻雙喜基金
  { sourceId: "080", fundIds: ["ed8c0355-e667-41ed-8d9f-bae2af3e6679", "31d77f07-b059-4d55-aa07-e94b6954c314", "a96bfce6-c159-4c8e-9212-e5d052f3e4fb", "c64bfaa6-4d17-4675-ae0c-f9c1a1712b93", "8ae478a7-2a28-49c8-ab80-ef9498de602f", "81fe3f9a-5660-4688-8fa7-d4e571917954", "fc56a8e9-e672-43b0-a222-5c516f06083b", "b5adcd8b-b27f-45c0-a708-f59d795ba26e", "c9637402-39b6-4f64-bb7c-3ecdf6c95d01", "d7f5e318-0ce4-4bfb-ac87-b9863115ed35", "67a56280-cb03-47d4-8aff-0748a9949c86", "f217f1a5-8136-44d6-8bf4-c69f6fd23413", "8cdaeac5-ef72-4575-9314-7d6223a2596f", "163bf83e-48b5-4c57-80e2-22a08c6d4e3f", "a749610e-78d8-44a4-8e4c-9ce82784b78e", "cda65dd0-5c8a-49c4-a07a-7b48c8fec494", "2d2e1152-0bc9-4c01-bb9d-13e57743e8a0", "cffe163c-e9e4-4a32-861a-48a6a67dce02", "4487da31-695c-4066-9cb9-9db2fbb5c6c8", "3cd38abb-cbef-4bcd-a02b-0e459e9882a7", "74611840-3b60-420c-8182-3f8daaf9a0e9", "60c7dec5-eeb1-45ca-88e2-62150204c599", "ca2deaa3-5e95-4a31-93cf-c4fa9c82399d", "15b28d7a-a741-43f9-9960-80dd80ad1599"] }, // 群益全球地產入息基金
  { sourceId: "042", fundIds: ["c74e5d4e-696a-4da5-b2ce-adad7ef1a0b7", "d515af8e-cf51-4b12-98e6-34a7440e5d8e", "bf95cc49-ae12-4c86-9b53-d237c2fe5df5", "bff0a357-644b-4749-b1bd-61071635f767", "2405c87d-7138-49a6-bd4d-9dde9d12e37f", "a5bbd574-9c51-4d31-b5f7-5a402ccf2794", "d509bb72-18a4-431a-a618-0f73f384ce4a", "f2db2969-40d2-438b-ac91-ad5fc3c397d5", "c7b2c85b-3f41-423c-8f4c-55e16cedf921", "0c5774c8-4cc5-4db6-b27d-62ff46ade755", "f284e397-4a33-4faa-8b5f-af72edd3a14e", "836e2700-bccb-48ee-bf65-f149bb1ec30b", "2ddd3b02-27e5-4ef2-b527-6a807fe3d0a9", "aa2c12c1-4a37-4c77-884b-1cf525997aea", "273ce6f5-b478-4f04-8005-a464462c8d0f", "4fe8420e-a1f5-4cd2-8fd7-c94fb2fed8bf", "a5a1f922-f6a9-4d87-8764-278b92e7447d", "f3e09164-159f-4b54-b258-a7e89d71d14d", "aae9a0ea-01bd-4c10-8606-4d76e0716c65"] }, // 群益工業國入息基金
  { sourceId: "061", fundIds: ["cd26365d-2d35-48a5-94cb-631678b75f39", "01b1fa7a-1194-4f2e-adbd-870536d18779", "4d93bba6-ff73-4103-93b8-3b2ca7c47de6", "31afcd6d-805a-4d8c-ba36-e210247aa93b", "eee819c9-1e30-4e75-9e89-221ad6a2b689", "9387c866-d61d-4078-83e5-920b6dcfc34c", "d81d395b-4444-4ba2-8bef-abc6c91b8789", "cacb4f37-f5bd-4e73-b132-5ec981314fb5", "7943db20-d7c6-40fa-bd2b-8135ff1cfc3f", "5fda5e54-fd7f-456c-a347-208eb244c1cd", "e16cc342-642e-447f-b21b-8ddef0e77ed6", "7375f1ac-a39f-4b46-a362-22b0a184f5d7"] }, // 群益中國金采平衡基金
  { sourceId: "086", fundIds: ["143b3b9b-1967-4e83-802d-460173d81d9d", "45130e1d-e153-48ce-8658-7270a6e09354", "91894def-15e0-44f8-9ae9-0c791158a10f", "a3a0ee96-8f23-4c70-a6cc-ca7aa7670c65", "470eca9b-6a3a-408f-9f8b-a0107f2133f0", "1cebc1b0-cd0d-4d78-8ec9-dd59032b9d36", "ea397d08-0d66-458d-8dbb-cfe408a392e5", "3a5e6373-4b34-4a5c-b511-67f2d671d6dd", "6c54f56d-7cd7-4cc9-99db-a54c9dfad19b", "277c8d7a-c455-4082-b58b-91b213f1208b", "d04d74e3-c42f-4173-860f-427a8433e1df", "31c874b1-dc0e-4210-930f-fb0965c25011", "dc3400b2-7126-43f3-838a-c9d5c6f30a89", "aace8fd0-3c4b-464e-a651-03550c80bea5", "cd7466d8-8944-4f49-bd8c-50f6b6867bc8", "da510fd8-4b7f-4682-8244-da0f8a048bbb", "2a237bee-e438-44e8-9629-fedc3a6dc7f5", "e207d9ed-9b68-4700-bc36-3597b5190b8a", "43f3ddef-21d5-40b5-a4b5-d459c9a49620", "bf6caf42-4f63-4ed3-bf68-2d41a16030e3", "8a40d61c-5a59-45d5-a263-e4f6454b5db8"] }, // 群益金選報酬平衡基金
  { sourceId: "096", fundIds: ["f2f58995-6920-4857-a8d7-a95c62980245", "867a3ac4-9b3c-4c1c-bba9-827307107b61", "8bcaefd4-d292-46d4-ba54-90eae1487151", "d5114615-b42e-4612-bb87-14458319a20c", "afff1e16-1f17-4522-855d-ac4a2e688ed7", "329aa9e4-82bf-4d9d-9bbd-dde72c4cb965", "f7bcfa37-3c32-46dc-8d6a-1d638d7a91ed", "b71dc8db-c20c-4f18-a002-bbf9b782d41e", "80de71d4-b7ae-4bae-96da-15dd7bf32c9f", "7d1d3ad4-1b1a-4e14-a6b6-fab96cc24f20", "75481406-da7c-4a87-b3ee-c018e9ca4e24", "fcb2b70e-b714-42cb-8bb2-6d1d08b1b646", "32f747e0-9ec8-493e-bc9a-4368db1f668f", "c4485543-e6fe-4a8c-a750-e8d70da66d56", "ba5c2068-b475-42e2-a296-8ae6c06f56af", "83361066-f69f-4d71-ad79-6e624ddfea8b", "ea9e5e31-861f-4676-8d40-78dcee53dc87", "934f3505-eb92-4b02-903f-77b4dc29440a", "6a57d63e-6e6e-43b0-b75e-25176ca16fc3", "5ca89655-173d-4ccd-b174-765e90cac9b7", "b34173b3-14a0-4158-80ff-b1500fbfdfb2"] }, // 群益全球特別股收益基金
  { sourceId: "379", fundIds: ["9977b107-b591-4f45-8e0d-1785e1ea5b95", "7767d0c9-a207-4f84-a366-f657b167e5a7", "b77126b0-f7e8-4bd4-9c6e-42bda470982b", "56195f1e-21d1-4ff6-a92b-644f9182e87c", "619f4aaf-22c0-4ef0-ac4c-da566e34c246", "e932d0e4-7042-480f-a971-da816f78e1bd", "0c67ed12-9025-4b6f-a5db-21fdb7d6be07", "d54359e5-67e9-4058-aed3-582989e5e9db", "13b5a396-2b7b-4a10-aea5-0d48b13a67d6", "dad9d35a-dc37-43c0-ab0b-06d8d31bf8d2", "cf4513c5-ddba-498e-bd7f-29567d8991cb", "f3a45585-6db3-4cfb-a1b9-30b39a5bd232", "229fa0d8-743f-4763-9641-cf2c1bdeb60d", "608308c7-6c9c-4316-a73c-4ae31b379157", "5e49eb74-b0a3-4dfb-8b2c-c591fcfe43a6"] }, // 群益時機對策非投資等級債券基金
  { sourceId: "177", fundIds: ["a50ec90c-8541-45c3-a6a8-13dd94be4160", "ba709456-e1f1-45cc-97ee-3e8f57072747", "277cad9c-04a5-4291-899a-ee5a78a01747", "d3c94942-283f-41ed-8408-da8100f950fc", "0e05d7dd-50fb-4f0c-a2f3-eb49679ab11d", "8ee2174d-f40a-4c8f-9769-4b9015c3db3d", "2e88c5b9-f976-41e9-9e17-7ab1c017c1d6", "06b22079-e023-48db-a437-76363f92cf72", "0a54b1a5-8152-4ed7-a530-61ec12d4467d", "1ea62494-b182-40ba-84cf-814f11ac9927", "6b2a9940-6fdc-41f7-83b4-3f5721e4eef3", "d67fb58b-bd90-4140-bf18-1cfd53bf95a1", "3835e7c3-59a1-4ea4-8dc8-2c16ffc46f39", "076339c4-7e16-45c9-b91a-3ed9d98c223c", "e8fe521e-b3f7-4710-936e-c6b881a4d823", "33db150d-e436-4d3f-a4d7-6aaa331276e7", "4712950d-5d0a-4659-b031-eaccbf41d026", "d9e85ce9-06c8-48bc-98ad-86945e29cfd1", "fca738de-c858-417a-924f-1f32e4f97177", "1637fd3f-6799-4ad2-a79b-6722eb474e3a", "6785d358-42d9-461e-b894-6ef0fbe326d8", "8d20414e-1621-4da6-a00a-ec741fe392a4", "cf6736ac-6d00-45ac-8f38-e786eea91748", "b2a47895-0f04-4775-a815-3365241da1f3"] }, // 群益潛力收益多重資產基金
  { sourceId: "370", fundIds: ["d9ec1aa6-7087-40b2-bc08-3eb05d6f51fb", "cb9f2648-537e-4bce-a98c-b0767e9a0bc9", "41e95eeb-9513-4e54-965b-00bcec6314e3", "3c225b0f-aa32-45d4-b1e9-f46d2a7a6ff4", "43d9586f-6d31-481f-a407-30aa7e5893a5", "44457f3d-9945-4bb0-acef-df95cc95358f", "e7ebc4b0-0a23-440a-b94e-1fa573f472ab", "7afeef3f-d0f5-4701-9127-5709472d27ba", "92f14c09-489e-4559-9e06-5f9360adbe38", "d5a38d15-c4c8-4f8e-946c-eaa6ba93e552", "7d366ea8-85cb-4e16-959c-5eb6e208ed22", "90a08e11-8703-4ef3-be9a-a943f22a09d0", "c127d6fe-d94b-4e3a-ab90-9b74db0eb8a7", "ac306987-38ce-494e-8741-a2fb29d9642c", "cefcd06f-255a-4c28-b8cb-c0f4079ba873", "3baabf08-bcf4-454a-94a6-43f64c442ffe"] }, // 群益優化收益成長多重資產基金
  { sourceId: "391", fundIds: ["8b5e0bbf-a6b3-4d62-86d2-5dfbb09bb66f", "c2767df9-63cd-48ef-9a87-02002881f2ed", "31601407-8903-485c-95bf-6759b47e6d14", "46d2c246-5a91-406e-a9e6-48d50f2ed588", "d627a697-fba7-4997-b0dc-7660da50443e", "aec61531-0d6e-4457-911c-1a3e5296f03e", "a657998e-be06-41ec-86c5-a1c118ad5fb2", "d11c4a94-0bf1-49b5-b8c2-0618b16c8a7a", "fdbdd88c-74ff-4f89-a009-df739afa4e43", "e44890ff-a06a-4f2a-b4b0-d24ba823db6b", "3d417209-7532-4d94-98a4-fd6afa79e511", "00e78723-aa55-4617-a86d-7f10951f2580", "463acc15-2347-4a12-abec-c9e3cae3fbf0", "3e66db8b-3234-4ad1-833f-662afbcb324b", "0566d083-b95f-4d31-acea-11c15ad07cbb", "c6dd4433-0567-4d70-927d-3f40a684eccf"] }, // 群益印美戰略多重資產基金
  { sourceId: "301", fundIds: ["a9216bc2-78eb-4a67-b862-c4498b0f4f67", "2e2564c1-9963-4287-9eeb-19c61b158b89", "15ff8ced-577f-469d-a501-fae1ecc880c0", "a6568f7f-6643-47c6-9b29-a974b9f37446", "8c9c0be0-8114-46ba-a880-eac3fad87452", "c5e98656-b6b4-488f-a2ab-1d287a03e8d7", "7fb68911-ca02-4ae8-b914-0aec994a1011", "4f347003-ac26-461c-b4a3-3834578d6581", "eec9c15d-f529-4b59-a944-132f093b5bb8", "a95434db-c5a8-401e-9037-d8de13083f3a", "0f8e113c-5de9-4039-bc46-76c8c23fd953"] }, // 群益全民成長樂退組合基金
  { sourceId: "308", fundIds: ["509d40d7-1a21-4fbd-9e2b-a2c6fb84b375", "89b31116-1e37-4849-b205-c2c271d8b9fe", "0d7b2ad8-19f3-4f07-a3fe-f635fbf130f6", "e8c258e9-bb21-4551-b2b4-e85a447fab37", "f4ee0842-8890-49b2-93f5-231902df6fd0", "cf04bff4-7799-46d4-a6fe-25a85e398ef4", "135b74f1-6c83-4c5f-973f-941a8accdcdb", "c73da09e-1e1b-49cd-95d8-48f57dba0c87", "39265479-2133-4304-97f0-21430a4b3bbb"] }, // 群益全民優質樂退組合基金
];

// 富邦投信（fubon.com）：基金總覽頁的連結直接列出334個fd(含ETF)/重複disclaimer連結，去重後
// 49個不重複基金家族。官網顯示名稱大多不含「富邦」公司字樣（SITCA CSV的基金名稱有加），比對時
// 兩種寫法都試、哪個唯一命中就用哪個。
// 2026-11-03 VERIFIED：29/49命中（59%），0筆ambiguous，dry-run(01A/04)對照的兩檔都在命中
// 清單內。其餘20家下一輪個別核對。
export const FUBON_FUND_MAPPINGS: IssuerFundMapping[] = [
  { sourceId: "01A", fundIds: ["e63b43e0-0de7-4f1b-ae01-33470e9e54fb", "b248d008-694f-43bb-a8c9-61b39f8338d2"] }, // 富邦基金（手動核對，比對規則的"富邦"過度去除bug，見下方29筆自動比對）
  { sourceId: "04", fundIds: ["2880d56f-8868-440c-ac50-ae44b7463a6d"] }, // 精準基金
  { sourceId: "05", fundIds: ["05c97c76-95d1-40c1-814e-9bd7a2498fd9"] }, // 長紅基金
  { sourceId: "10A", fundIds: ["72d38a95-26e3-4846-b48a-3ad21ce0db99", "10a7232a-bfa7-4a83-bc36-ea6cbfa05b18"] }, // 精銳中小基金
  { sourceId: "11", fundIds: ["24eb6a4e-d86a-4ebd-8c88-844b29b5766f"] }, // 高成長基金
  { sourceId: "12", fundIds: ["a0a824a7-b905-46bd-a8b2-7c9d8ea882ce"] }, // 科技基金
  { sourceId: "17", fundIds: ["c3bea066-f04a-46ac-9046-925223c0f9c4"] }, // 台灣心基金
  { sourceId: "08", fundIds: ["8e0c2aee-9bb0-487c-8b91-8bbb8ce2abcd"] }, // 吉祥貨幣市場基金
  { sourceId: "201", fundIds: ["2578a83d-f4a6-414c-8a5d-5b797fb96806"] }, // 貨幣市場基金
  { sourceId: "200", fundIds: ["e6f3a557-5db0-489b-9274-635b75170338"] }, // 日盛基金
  { sourceId: "203", fundIds: ["5adcc49e-6899-48c6-b41c-0209552fe2e7"] }, // 小而美基金
  { sourceId: "204", fundIds: ["43aeeda8-98c6-4015-a807-98d83e05a934"] }, // 精選五虎基金
  { sourceId: "205", fundIds: ["769c0cfc-7f28-4ec8-8e55-612c1388654d"] }, // 高科技基金
  { sourceId: "206A", fundIds: ["d68292d0-ba3a-4389-9952-49616be4bf9e", "e4784a1a-044e-4f2c-87b1-f3454a0dc9c6"] }, // 新台商基金
  { sourceId: "208", fundIds: ["e80c7bfb-28d2-4b20-bc2f-83886ebb8417"] }, // 首選基金
  { sourceId: "89A", fundIds: ["4525ca9f-181a-4afd-9933-8230bb31f924", "89332882-fd0d-4521-9344-1a7e26fd0e8c", "cd3bb7ab-4d9e-4eff-ac07-4b8f442bfd31"] }, // 台灣高股息基金
  { sourceId: "222", fundIds: ["279cc8c7-06d1-4022-869f-c594e60f6151"] }, // 台灣優質多重資產基金
  { sourceId: "216A", fundIds: ["dd43f739-f58a-4364-aff1-299ff8b00ca0", "6e7c8694-046d-45ed-a2ce-427c2d8986a4"] }, // 台灣永續成長股息基金
  { sourceId: "102A", fundIds: ["c78db6f4-666a-490c-837f-f9ccbcc50df9", "1716b52b-25b8-4822-81fd-20f7067161f8", "b60e22a0-7f92-40e0-8647-096e454a15b3", "bf9a387b-c5ae-4469-9fd9-14dffebd311c", "bd5258d4-87ba-4be7-bc46-209c3b8ddc10", "bd99e8f9-6126-40a9-88f6-974aa46066f1", "56ba675a-8139-47d3-b5cb-a898731b999c", "b0ef4a9f-6432-4955-a80b-d9bb94fd685e", "ff0f8fb0-c0d8-4b56-b236-85766a141de1", "1b14a080-6b16-44fc-9958-ec606de2b953", "3986d917-0a41-4a98-bdd3-d1faaf6a3415", "7f29abed-2ea7-4c3c-9d8f-e59b1aebb447"] }, // 雙核心戰略多重資產基金
  { sourceId: "26A", fundIds: ["eb17c066-6f81-4a8c-b926-8020a326f06b", "ba6ff68d-c24f-4ac9-9b25-6e3bae12a372"] }, // 全球不動產基金
  { sourceId: "28A", fundIds: ["381f0034-cf6d-4fb9-9ccb-41740f8df597", "6bf9133c-3df2-4238-bd4c-a3708578b151"] }, // 大中華成長基金
  { sourceId: "34A", fundIds: ["a56e2144-bd6d-4d23-b1c3-9c81b0ea5f5d", "93a8f36c-c0e8-4c99-8e23-95f502f9a1e9", "01fbbed7-e96a-4381-9a8c-4c501ab13019", "6ad0d251-01de-45ec-838c-01f7da7bbceb", "c59c8602-bda7-427c-a4be-e52837c10c85", "feb099b6-a07e-4213-aa9a-0ff9129ca0c8", "6bcfaff1-87ee-4d31-a1b0-9fe53686a530"] }, // 全球投資等級債券基金
  { sourceId: "63A", fundIds: ["445cfa94-2197-4934-9c72-9f74c10d5ea3", "4705a07c-6dbd-4903-aa96-1bfb1ec4eabe", "b071b4ab-917c-41dd-98f9-e922b447394c", "fc50e5de-51a2-4c1f-9db6-0781346b0667", "0f870923-de5d-42ff-9f1d-c9624ea660c0", "7960ca0a-3e98-4848-b9d9-af55a4ef4563"] }, // 歐亞絲路多重資產型基金
  { sourceId: "80A", fundIds: ["7c7106f4-438b-4fa7-8c83-2f840ca94315", "47d4d839-fd4c-4d05-b988-0cf3f8d9d7c3", "50784743-9d15-42b1-89c2-5577fa41b42d", "1be1fa76-fbe3-4f38-888c-b556325195fc", "612d5640-f0ac-49f6-926d-40906f010c00", "c1a4cc21-ca2f-4157-9b3e-51cc11dbbb9f", "b2889703-eacd-4c3a-b3ff-0e96458414c4"] }, // AI智能新趨勢多重資產型基金
  { sourceId: "97A", fundIds: ["fe855b1b-5514-4eaa-a853-b1b8f3fb4406", "237720b1-5808-434b-8cbb-beaef3902d57", "d4be47af-9b4a-430c-b266-f181dda12cac", "f3071b80-e963-4e13-bef8-632b3c3d3dce", "53f18099-8a83-471d-a63f-b55a9e127a1c", "bb9ac015-0d86-4f9d-8c20-3de0a51b63f6", "c0ef85fc-e253-4173-929d-d956a81f5b61", "0e8dbbff-9e60-490d-9e78-7e1965a6dd47", "6da0356e-d938-41f7-90aa-2d3f91f7c24f", "1190d159-dd11-4548-bb1c-fef6c7027bed", "085a0ca4-54fd-452b-856c-e36de81692bb", "d0565b6f-9dee-4b9e-8e80-87cf1c4d95ca"] }, // 台美雙星多重資產基金
  { sourceId: "207", fundIds: ["fff30a68-5178-4a44-8e9a-8097b7d49d2f"] }, // 亞洲機會基金
  { sourceId: "211", fundIds: ["30416aac-be46-49ef-b20e-de84de1b1e19"] }, // 中國內需動力基金
  { sourceId: "209", fundIds: ["1db501b5-3a31-4ee2-80dd-8ad86a1ddd46"] }, // 全球抗暖化基金
  { sourceId: "108A", fundIds: ["f22c19db-928b-4783-804c-d0c0c3f8f192", "6debb602-7a19-4642-a1ef-9ab89d2997b5", "649df543-eddc-4d50-9435-01db879e0365", "b1501f27-d9b9-487d-9c37-ada9e6e80b2b", "21fd9695-a5f5-4ced-81c8-becbff1abd3f", "61b7e2c9-f6a4-441d-a467-9e25d5e2eca8", "d00778af-d6bf-47ce-871a-08c093ecc585", "d72df4b0-cb8d-4ad4-9eba-5dbdd35deb76"] }, // 景氣循環多元資產組合基金
  { sourceId: "110A", fundIds: ["6f8b81ae-d1f5-4740-aec1-6ae6090c7568", "37c650f3-058b-4267-b218-236b4868d80e", "d8132778-8c7c-437a-a1ec-df5df0308af8", "4e84374d-2481-47e8-b5a4-866e9e11784b", "87fcb5ed-eb4c-4f7b-a387-5f71f8267b8b", "78fa7b8a-6baa-49af-95b9-3471313f3a92", "2c40da81-b534-48cc-80ef-432178505723", "ae830786-5777-4135-a14c-379df9f791fb", "68da4171-8738-431d-8c1c-09fa93da398e", "54e7ef0e-cbbf-46c9-a92b-4b7fe2462cd2", "73bf6496-eff7-4af8-a760-6a1f64eed18e", "d535c728-c50a-450e-974d-3d0d6e34b194", "f897d064-44fa-40ae-954d-9a0d024c409e", "7abf1d11-0369-46f2-89c8-971bd01d796a", "4c92df2c-f3eb-4ba2-932a-502f0ea03b4a", "72ddf0f4-90b2-40c0-a8bc-b66c79600555"] }, // 富裕商機多重資產基金
// 2026-11-04：剩餘62檔用跟台新/群益同一套「去幣別/級別後綴，基金層級名稱比對」規則補完
// (lib/cloud-ingestion/issuerFundMappings.ts的baseName規則，含富邦名稱省略公司前綴的雙候選
// 比對)，61/62檔對到(0歧義)；僅「富邦MIT主流基金」在funds表查無任何名稱變體對應列，
// VERIFIED非比對錯誤、是真的不存在，維持不比對。這批含多檔傘型ETF子基金(確認funds表內
// 有對應列、不是交易所掛牌ETF)。
  { sourceId: "202A", fundIds: ["63478e5e-b7de-402f-b0c7-6b336c269ff8", "5e110fed-caf8-4da4-a778-27ebd229fd41", "64c00b3f-11fa-4330-b6a5-99ff3e7b1fe1", "1f4f66b0-8aa5-4ea9-bb08-8f272d72134f", "6f09a4ec-2678-4a0e-8b53-d5a995b99ebe", "ef8b4777-c1ee-4868-846b-a3f2a44b0ca6"] }, // 上選基金
  { sourceId: "41C", fundIds: ["0d8d97c6-ec3c-49bc-8a54-133adc1d2d73", "786f9ee1-3261-4395-8cac-2a05b0f13948", "82b22ca5-741c-4107-935e-406c8392387f", "5e01fdc4-c0a7-49cb-8a48-ff8e7032f0ff", "dc083425-2e23-41ec-9c67-08659a316c50", "c88c7a68-c001-488e-a8fe-3072359e4a18", "3de4bdf5-4a3c-4582-8487-f2e85efa445c", "043353b8-e0b8-4da2-8aba-0b44c9ef6b05"] }, // 中國非投資等級債券基金
  { sourceId: "42C", fundIds: ["0a5cf478-fa5b-4a55-8b0c-dbfe6a1d2132", "0402cf9d-cb72-4e0a-b146-ba1777cd7be2", "7b8fff93-41f9-44b9-b7c5-c8fb753416ed", "a98ce9b2-68f1-4713-b44c-7e733b75f868", "c130305c-ce93-4e29-b0d8-e759e5e2feac", "b35f1b28-1866-4426-a991-dbfcee72ebbd"] }, // 亞太優質債券基金
  { sourceId: "217A", fundIds: ["407e385d-09be-4107-9010-4a1969077486", "9b291622-20de-4ba1-a5ae-6ce87849e4ef", "f19365d8-96f4-495a-b97f-289134f080b1", "8c47b11e-cee9-4b05-a35f-0b6ea2c89a64", "2f793057-49d5-4548-a893-c2975f903e60", "bdc1c4ca-5140-4162-bde8-d64fd1f4c5c0", "5e5990f3-1441-4a6c-ad36-72476891437c", "c7214667-206e-44d6-a3ab-9a3e7f37c4a4", "9cdb0fdf-82a1-44fa-85bf-99bdef51d237", "4fd1c35f-2b93-4d7c-9f5d-38700f4b8d02", "5c72b3a4-0de3-4412-ad10-f075219cce5e", "c6100ced-f0b0-4fb2-8777-089e6680e1f8", "29038e8a-b8f1-4437-8a22-0ca0c29824f1", "9345137e-0237-4645-87dd-c030c4ea210d", "3733c578-e219-40d6-915f-ea6d58f52435", "3aba4da7-f2fc-440b-96f8-2bf6d6f7c887"] }, // 長照產業收益不動產證券化基金
  { sourceId: "213A", fundIds: ["f708fbd5-11dd-4f19-af08-3350ee62e43c", "d9a3f6b5-4d23-42b2-a4c1-a7cba1c32e09", "ab33881b-f41a-4e40-9353-866c6fb36b1b"] }, // 中國戰略A股基金
  { sourceId: "215A", fundIds: ["606904b5-e3ac-43fa-b93d-edd8399c0825", "0f644966-c8e7-45a7-a9bb-e58781ff6cdc", "73ce7f32-8962-41bf-9607-9a697123b176", "9dfa311d-9178-48bb-b32d-bc35bf6f4b08"] }, // 全球智能車基金
  { sourceId: "221A", fundIds: ["754237e2-0925-429a-b2e0-f55dae0cefd5", "a8dd043c-a1ce-4e1f-980d-c351cacf764c"] }, // 全球關鍵半導體基金
  { sourceId: "212A", fundIds: ["d2bce4c2-cc73-4e24-b292-27e096af30bf", "b9fda90d-ec6a-4419-9cf4-e142d9b3dd25", "6b3db3dc-8726-48a1-beaa-43964351812c", "3d9f23e7-90a4-43df-9b97-2d34bdfc78e8", "508fd4b9-eae8-43d4-8b0b-7fa29178c02b", "df79a9f7-f82a-4df1-842f-0db0781fb8de", "f2692298-8c8f-45d1-adc8-3793ef197eb5", "bf352349-67e6-45cf-ab75-d75af4e4337e", "7cd49ddc-c1a0-446b-b0b4-299a9719fd5f", "47d116fd-4bcf-4cd6-9cc1-50b1fc07d066", "f05cafbb-ada7-4d3c-9a46-891c8a30840e", "034efff6-a074-4214-a014-4899b4dece3a", "88d05fca-24ae-42f1-b74c-a7708d066c2b", "e4b4e9ba-fc1f-4170-b636-28c8f94381d3", "dbf46895-0645-4ee3-8360-3cea47c29e2c"] }, // 亞洲非投資等級債券基金
  { sourceId: "218A", fundIds: ["947547ce-3638-435a-b958-4d92c4a5c68a", "83ee3728-0f59-490b-939b-2338fe8d9fb1", "e5b21071-53bb-4f02-835c-899cccf7e2e0", "bf5fe81e-0464-4f2c-a8b2-d6d847990067"] }, // 越南機會基金
  { sourceId: "70", fundIds: ["6112c39a-6575-4262-8a8b-b9e6507c6b8e"] }, // 標普美國特別股ETF基金
  { sourceId: "100", fundIds: ["6a989e2e-9db2-462a-b5a3-1b091d9f2013"] }, // 台灣旗艦動能50ETF基金
  { sourceId: "94", fundIds: ["7915b152-2859-4ab3-8e11-3ce17ce34272"] }, // 特選台灣高股息30ETF基金
  { sourceId: "91", fundIds: ["6db6c7ea-7218-49e3-9738-df7c95e8c244"] }, // 台灣核心半導體ETF基金
  { sourceId: "101", fundIds: ["dea6af91-071f-406d-b555-03be90ac8083"] }, // 台灣淨零轉型ESG50ETF基金
  { sourceId: "74", fundIds: ["21085b18-1f6e-4206-a024-b7ec5754eef6"] }, // 台灣中小A級動能50ETF基金
  { sourceId: "72", fundIds: ["a8b365ec-124d-483e-a699-c8d8cd998c34"] }, // 道瓊台灣優質高息30ETF基金
  { sourceId: "64", fundIds: ["cbbff568-5345-4898-a80d-b0a4610a95de", "84658c0f-63c4-49fd-b16b-f0f4c84a22cd"] }, // 台灣公司治理100基金
  { sourceId: "40", fundIds: ["7afa53cc-fed9-4be9-8146-8836a94b2e6c", "0e495a8e-ed04-4bfc-bfa6-4c9e996f6950"] }, // 台灣釆吉50基金
  { sourceId: "60", fundIds: ["f503fb47-8ac3-4ffc-8ade-6595675174d0", "36afad1e-d591-447f-b2e1-02de93fbecdb"] }, // 台灣加權單日正向兩倍基金
  { sourceId: "61", fundIds: ["335ea337-965f-4e9d-9ea0-12eadd7ee139", "94d85609-36ed-4c57-9c03-26bf2a6b1e47"] }, // 台灣加權單日反向一倍基金
  { sourceId: "29", fundIds: ["2f43df64-491c-40b0-837d-e86177819161"] }, // 台灣摩根基金
  { sourceId: "27", fundIds: ["335ce95d-ef39-4ffa-9e93-9096ef94bf04", "f1cff526-eada-4160-a821-7fd7e6525bd5"] }, // 台灣科技指數基金
  { sourceId: "90", fundIds: ["98250f12-cdc2-45cf-9a29-4a2fb0ea8b29"] }, // 富時越南ETF基金
  { sourceId: "36", fundIds: ["27393f3e-1980-4698-943d-e881619e698a"] }, // 上証180基金
  { sourceId: "45", fundIds: ["2d9f546b-715e-46c1-b8fa-9528d27d8f3c"] }, // 上証180單日正向兩倍基金
  { sourceId: "46", fundIds: ["ae6d8158-2bbe-4cf3-a23b-601925d327b1"] }, // 上証180單日反向一倍基金
  { sourceId: "48", fundIds: ["1ff5137e-87b1-4cd9-8a68-7f29695372f1"] }, // 深証100基金
  { sourceId: "81", fundIds: ["b9f72a6f-53fe-4d04-b18e-56a3d406e284"] }, // 中國中証中小500ETF基金
  { sourceId: "68", fundIds: ["af559a00-9f69-41f3-a979-1fb4bdc9a01a"] }, // 恒生國企ETF基金
  { sourceId: "56", fundIds: ["bbc488ac-e581-43c0-8e68-3e452176e430"] }, // 恒生國企單日正向兩倍基金
  { sourceId: "57", fundIds: ["200e7379-0a7a-4c76-a894-f431744ec7ff"] }, // 恒生國企單日反向一倍基金
  { sourceId: "51", fundIds: ["26b201a2-80c8-48c6-aeb5-b03d694cb83a"] }, // 日本東証基金
  { sourceId: "49", fundIds: ["d6ee6825-c89a-43c2-96e1-9510454bd4f7"] }, // 日本東証單日正向兩倍基金
  { sourceId: "50", fundIds: ["34ee7e2a-dd1b-4004-aa25-ffe9c4a29da3"] }, // 日本東証單日反向一倍基金
  { sourceId: "52", fundIds: ["3de49b95-f67e-4515-ac26-11bb34828f2d"] }, // 印度NIFTY基金
  { sourceId: "53", fundIds: ["e030221d-7506-4a00-9fce-a64c2455508c"] }, // 印度NIFTY單日正向兩倍基金
  { sourceId: "54", fundIds: ["34231bb8-f607-417e-9909-c928c9596c5e"] }, // 印度NIFTY單日反向一倍基金
  { sourceId: "98", fundIds: ["9671279d-23eb-44bd-9800-958cd57b6a62"] }, // 全球ESG綠色電力ETF基金
  { sourceId: "96", fundIds: ["01f8494e-c130-4fb1-8190-f508078c5f8f"] }, // 全球入息不動產與基礎建設ETF基金
  { sourceId: "95", fundIds: ["f1d862dc-9d87-4120-8099-d4fcf8ddd1ee"] }, // 元宇宙ETF基金
  { sourceId: "93", fundIds: ["1a4541f9-588b-4cc0-bcf3-26a49d1a1f13"] }, // 基因免疫生技ETF基金
  { sourceId: "92", fundIds: ["7144b66c-7536-4991-925b-78d3e80ff12b"] }, // 未來車ETF基金
  { sourceId: "55", fundIds: ["f82251a4-64f4-40cd-bf2e-fcee7400149b"] }, // NASDAQ-100基金
  { sourceId: "58", fundIds: ["e229bbdc-11f2-4295-8d0e-d26ddd173ac0"] }, // NASDAQ-100單日正向兩倍基金
  { sourceId: "59", fundIds: ["82549559-4ec8-496a-b549-a4a378732404"] }, // NASDAQ-100單日反向一倍基金
  { sourceId: "69", fundIds: ["e05afe63-b3e5-4222-8066-9cd6bbefc9a4"] }, // 富時歐洲ETF基金
  { sourceId: "65", fundIds: ["5b68c1b8-e840-4a5d-80a9-1adc5485a57d"] }, // 美國政府債券1-3年期基金
  { sourceId: "66", fundIds: ["4d044aaf-9436-41ef-99a1-fd8fb34f2455"] }, // 美國政府債券7-10年期基金
  { sourceId: "67", fundIds: ["efb8cba3-d704-47d8-a0b2-c41c50197423"] }, // 美國政府債券20年期以上基金
  { sourceId: "84", fundIds: ["c167fdea-84ff-4b88-9891-c55b327f8a1b"] }, // 中國以外新興市場美元5年以上投資等級債券ETF基金
  { sourceId: "78", fundIds: ["3c577f79-33cd-4c5d-bcda-67b9a5b31d6a"] }, // 彭博9-35年A級美元息收公司債券ETF基金
  { sourceId: "76", fundIds: ["ae9d28d5-d8cc-4260-88e8-9dc06726a532"] }, // 彭博10年期(以上)BBB美元息收公司債券ETF基金
  { sourceId: "75", fundIds: ["fc95c76d-bb98-42ca-8280-cf9a173e82ed"] }, // 彭博優選1-5年非投資等級債券ETF基金
  { sourceId: "85", fundIds: ["a02e8c27-6391-4b7b-8aa5-afad9edb34fb"] }, // 彭博歐洲區美元7-15年期銀行債ETF基金
  { sourceId: "83", fundIds: ["6fa5fe8c-5b2e-4632-b859-a807af9abf2a"] }, // 全球金融業10年以上美元投等債券ETF基金
  { sourceId: "105", fundIds: ["c9ac4e3e-e24c-46f6-895b-277391babfe5"] }, // 標普500ETF基金
  { sourceId: "103", fundIds: ["9b6828bb-e228-4ca7-af86-e4ffd130008d"] }, // 環球動態入息投資級債主動式ETF基金
  { sourceId: "104", fundIds: ["7d5aa2f4-35a6-4679-befc-480000380b47"] }, // 環球複合優選收益債主動式ETF基金
  { sourceId: "109", fundIds: ["80286ad1-8164-42b9-a8a2-e9d1005a32c8"] }, // 台灣龍耀主動式ETF基金
  { sourceId: "106A", fundIds: ["19824633-7669-445b-bb1a-3f253db4738a", "aa755667-f10c-4dd7-8a17-030702c8c31c", "bf2dbfa4-ba1b-4476-ac91-4d615d06873e", "bf87de30-9fab-4b86-9486-68981d3224db", "1b7f7453-ca73-490f-9c35-2492c3971375", "3a7c3778-8bbf-4a43-ae70-83e3740842e4", "323b3477-239a-440e-8220-5d8ce946521c", "ff7a46ba-2a3e-4438-966a-d73fc7f75169", "5555f049-5ff4-4d3f-8901-823a1429c987", "62b9dc7a-35d9-4285-802c-3680c49abceb", "513ffdb4-d972-4fe8-883b-2bc2ead78225", "09989c92-32fe-42db-a48f-4443806c986d", "5e36d23c-4d0a-4d08-8724-04bb8b7456df", "b67449fd-3c1f-4a25-a052-4a6c26fd432a", "a766e64e-12a6-4e8c-ac39-3396d1edc950", "4856a527-e50c-4123-8045-26c96b049578"] }, // 富邦標普500指數基金
  { sourceId: "107A", fundIds: ["9e66e4c1-f27a-4efb-abd9-596cba497335", "c7f621d5-fa11-444a-87b6-fbcbd96dad9a", "3530e588-8d6f-48fc-b7b0-3564be85b0dd", "c86bd4ce-89c3-42a3-81c2-03bd6a5c4bbf", "255236be-f46b-46b0-af84-c05be75bfc2a", "c2e0a815-596f-4f4e-b895-1ce9d571e221", "deb591bb-4dde-438e-a284-5c515e87afec", "0923d012-a761-42b6-9280-b89edc617924", "fd9ed17e-a930-46ba-be41-8ce008909b0d", "ada4f956-862e-407b-a8aa-1f891be15078", "f669a62c-94b4-4fa1-9eca-d44d8cc1e4f2", "946b67f5-4d54-46cf-ad70-c9ef7ab8e11c", "c44c2ab5-9cec-4486-83b3-7c3bf26733cc", "32dbdf3a-f560-4fa0-bb8c-c41b6ad7b83f", "e3127726-dc52-43fa-bb33-80664679abcd", "90cac81c-be84-4b70-92df-7f84fefc46c3"] }, // 富邦NASDAQ-100指數基金
];

// 台新投信（tsit.com.tw）：持股屬於基金層級資料，站上同一檔基金不同幣別/級別各自有不同
// fundID，但前十大持股頁面(FundPortfolio?fundID=<id>)回傳的是同一份表格——所以用「去掉
// 幣別/級別後綴、基金本身名稱完全相符且只對到一檔基金」的規則比對(見lib/cloud-ingestion/
// issuerMonthlyHoldings.ts的fetchTaishinMonthlyHoldings)，43/43檔站上基金全部對到，0歧義
// （2026-11-04 VERIFIED）。sourceId用該基金站上任一級別的fundID代表即可(抓到的是同一份
// 表格)，fundIds是比對出的全部DB share class id，寫入時全部一起更新。
export const TAISHIN_FUND_MAPPINGS: IssuerFundMapping[] = [
  { sourceId: "223", fundIds: ["b3e416ba-7672-420c-b57a-289c948edb12", "4073257a-4f2c-496d-aba7-af8db2495fde", "489a0c96-261f-4c0f-8c50-176ac1fddd84", "8a79f404-561c-4b61-975a-62ae2530a4a6"] }, // 台新2000高科技基金
  { sourceId: "501", fundIds: ["b845e47d-cfc4-46c2-85bd-3ba4270bd03a", "93b5810e-345c-4508-a62e-b027b43d3738", "d3d09863-0f07-4ced-8c10-695e9806e59b", "efd2f12c-2cb5-4328-a08e-6a5a0373d399"] }, // 台新中國通基金
  { sourceId: "278", fundIds: ["6101fbe9-cbe4-4532-a7d2-9931db24cf9c", "80bae47c-cb3d-48c6-93b8-c9f897717c35", "1a4c894f-c0b0-42df-9ae5-c26288981353", "ae3448ff-4f25-4fba-bf39-c350aa6cded3", "2413d04a-36c0-43ea-ba6d-11d77f6302fa", "bdc75829-6cc3-4b6a-be9e-48bb05fb3933", "98dab225-f610-4832-a848-42b9e9f70867", "e3275a36-8743-4e8f-82f6-94ea463ee35d"] }, // 台新中國政策趨勢基金
  { sourceId: "176", fundIds: ["3075b88d-a531-44de-8b8c-51e74adf0099", "cbc2022c-28cf-4f1e-8303-56aa4106907c"] }, // 台新中國精選中小基金
  { sourceId: "174", fundIds: ["cf689295-d967-4abe-9072-de2756a6a2a8", "d7f86172-d5fa-49c0-a059-421dad9e3681", "06494b62-c11c-4594-99e2-9ec256830f02", "a3f39702-0c1f-4dba-92a3-794179d66b20", "3ef2257e-9fe3-4b3f-8960-c98693e06fde", "79b2ada0-cacd-4aff-b354-05cc4b3f6a1e"] }, // 台新中証消費服務領先指數基金
  { sourceId: "124", fundIds: ["1b6ab683-0822-4099-aabd-731e9e48ce55"] }, // 台新印度基金
  { sourceId: "499", fundIds: ["e81ea009-6548-423a-9b36-2eb52402b0eb", "6026d13f-98bf-4bfd-bae2-82a9d2c52678", "624c0543-1ed3-4e2e-b5de-2c7bc86ad178", "7ab00d4f-2a26-459e-a41c-73aa6261a8d1"] }, // 台新台灣中小基金
  { sourceId: "409", fundIds: ["961879e3-9696-4339-8b62-48d2b3038f68", "ac2e9798-f8cc-44e4-93a8-e7b0ef68baf8", "b1c17eec-ea7e-41b9-a76b-ac2fc97abdb1", "53286640-d790-44c8-a95a-95a82aacade6", "d981b234-fe6a-4bd2-b523-15fd920eccc7", "ff253199-4dec-4eaf-9a46-ffc76afa5f9d"] }, // 台新中國成長基金
  { sourceId: "443", fundIds: ["e59ff192-e5f9-4baa-978c-73684cff8de6", "c09abc74-c4d5-4671-a33d-1884e8ef60e3", "ea288c1a-ba1c-40e7-9a3a-6a0a2ca2660d", "7599a3ee-bae4-4f24-9452-db5bb847240a", "01585bb8-be23-45da-bf95-de7162808990", "a2df038c-99b9-424d-9faa-02d14cdb1e66"] }, // 台新恒生科技指數基金
  { sourceId: "389", fundIds: ["e4f7625b-3a67-413b-8133-859d099cd1bd", "b63f1145-54bd-43e3-9208-c96de9de7524", "4c1326d9-55ec-4e9c-94cd-14ebc03f9292"] }, // 台新創新科技基金
  { sourceId: "390", fundIds: ["ad20ff30-9f4f-47d5-9d55-2e4fbe838344", "4ee6ebf8-dbf3-4aa9-af8c-4bdfb2479468", "282fb844-3cd1-4e1e-915a-02df85c09509"] }, // 台新店頭基金
  { sourceId: "122", fundIds: ["80794836-676d-415c-8204-45a58371efa3"] }, // 台新新興市場機會股票基金
  { sourceId: "498", fundIds: ["a0ca81a9-f32d-488e-ace9-b08b274ce34a", "dc7d4a3b-dd3d-466e-8327-fb6f9dd8e4f1", "739d6fc7-7095-4260-9a97-7b0d937bcb4e", "dae4fb36-adba-4583-ba40-e76921f1c56f", "ca267014-cbe1-4c6d-accd-61bfe352baba", "c51d650b-c261-4684-bde5-59a0118b7513", "495d2acb-0cd5-4021-af7b-db167ebdcf7f", "7e88a38e-def9-45e7-bedd-3c84d1cdd7f8", "ac4b1d4d-c655-4165-9a6c-6fb0901d039d", "f67e613a-de54-49b6-a3a0-07c59e3e6972"] }, // 台新高股息平衡基金
  { sourceId: "267", fundIds: ["9c49a008-3427-4c45-9bc6-1c414714469e", "0de189a3-d07c-4d71-8b95-7d75cfa2aba9", "f62335c2-1307-495a-b6e8-c90e805a328a", "8eafd519-07f1-4a6a-a376-1a1283e29ae6", "75fa34de-08bf-4849-b2f8-21930879c357", "53cf465c-6009-4e56-b2bd-69f74c39ea2f", "94361fd3-4954-4ace-9986-82bce90b97bf", "d2158827-19b6-41e7-bfec-1ebcc9bce85e", "58590f79-0b1b-4933-936c-12bb927eb492", "c223eadd-b674-497b-b4d9-2e89d1bdaed4"] }, // 台新ESG環保愛地球成長基金
  { sourceId: "496", fundIds: ["ce00e6df-54e3-4bd8-b001-dd51efb55ef5", "1e2629ec-b47d-47a2-ae67-aedf168a9f40", "56bb57ca-7611-449f-bab0-dccb1eb09635", "d4a050fa-1ff6-4aa7-a588-a3f36bede777"] }, // 台新主流基金
  { sourceId: "137", fundIds: ["ac115ff9-b7cf-46b9-9aaa-504ef8443bc5", "63ca976a-0dde-406c-92b8-e3dcfd74f33a", "d59c8e17-56e9-4265-96eb-bc0c0a95749e", "85a242eb-1ff0-46b9-8aa9-13b87d46ed26", "1ee84b16-4d12-4071-8f13-19f14cd57c65", "9c758594-f86b-4bce-9528-a19528259522", "a13a0d4c-fd0f-44b5-9c77-30873ebab5ae", "10d80ef4-f324-4bbd-950f-2250a9236d80", "87daa528-8fef-42a4-99f1-0f01ff16cd4f", "d791ad32-2f0a-494b-8a93-5ed28dd40aaf", "166f168d-2cb9-406c-87b8-e4754799615f", "8e4766cb-ceb1-4f9f-91fb-d47b2cf4788c", "24a0c396-5c90-45cd-a996-d8d55028f6e4", "a1159e29-7cc3-4c13-a963-3229644c5f8d", "6b3c301f-0221-4bfc-a0ed-6f9c86f7597e", "82870f1e-1668-45c9-bf53-467b628d83f1", "4aa524e8-8918-49a7-8f37-3f4998f498b2", "a6c613b5-8df3-405b-82e7-b5d1cfaeb715", "7005db88-4aa9-4461-90a6-a546ef474fd3", "3c3ab400-04bb-4c49-93a5-f9e095174782"] }, // 台新北美收益資產證券化基金
  { sourceId: "481", fundIds: ["3dfe58b9-a23b-414e-ba3a-38ea9fe83a73", "d23e37c4-9e9c-4968-b97a-d473fd1f2ae0", "668f00fd-fe41-4c86-b16a-ca4cabc5f590", "b5f78a54-f595-4c6a-882d-0c6b6bd7a8e7", "4ef7d82f-34b9-4115-8329-d92b5548b45d", "fee79a78-6646-41ba-a479-31e9f391f2c9"] }, // 台新大三通基金
  { sourceId: "417", fundIds: ["7ed25a45-3ec0-46cc-904c-f4675b957589", "b803fca1-57d8-47d1-a7c7-06ee0cd632c0", "68d090af-e5b2-4ad9-bd62-52685cf81355", "47313082-d2dc-4b38-878b-ac582d738b09", "f21bdd72-c26b-414b-862d-a7389c774b40", "65af5967-5bdc-4db9-a2f4-54f47ca58470"] }, // 台新全球AI新創產業基金
  { sourceId: "507", fundIds: ["508040ab-370e-4d99-83ec-c64bbbd115a8", "19ab4538-8e53-4070-ab73-dbbd66705a94", "8336d51f-6c72-4659-900d-f8184be9b91c", "fa2f5c72-2811-4107-ac43-a6b55710e5c7"] }, // 台新全球AI電力基金
  { sourceId: "495", fundIds: ["0886cd4e-0491-4a34-a9ea-f8c38358d2c5", "fac711dd-73b1-4153-9674-a1fb1c420722"] }, // 台新彭博美國成長指數基金
  { sourceId: "356", fundIds: ["712afd40-ae4e-4852-a096-2420f6fbbc7b", "a9a08bb0-8fe7-49ff-852c-7ee5eae07bf3", "0a65e123-0dfa-4d0d-8776-f93e83cc3b36", "819b2181-e036-4612-bdb0-21df850871cb", "425349a4-b106-4272-b109-c39757fce8d5", "4b217cd5-c61f-4df3-8512-807f526fc08c", "6cb8196b-d43d-43d0-a8c2-49793e433f1c", "2c0edbc2-01b5-4a0c-8994-9413fc1a3457", "3a3e22e1-e110-4dec-ba67-ae47eb6e8bd7", "9e6b9f1c-4572-4a0a-9023-f8fc7d548cf6"] }, // 台新美日台半導體基金
  { sourceId: "483", fundIds: ["6fc9dd9f-ced7-4f93-bb22-32986335f125", "21483c1e-010f-4c93-8748-25568f61dca3", "cbb07d86-9143-42df-844a-feea4cf954ec", "70ef5027-638a-4bce-88bf-311e87d73f54", "c62fb464-480e-49d1-9992-c3855580c837", "b3b72c92-8964-4b32-bf2f-41335033599b"] }, // 台新台灣富貴基金
  { sourceId: "462", fundIds: ["da4560ec-d5ad-4d46-b50f-2d79cc164010", "43fdd927-94d9-4f83-a9a3-39b78c055204", "50ac49b1-01b8-4954-b1ff-2f6e47a7b2ff", "e2084650-19ba-401f-9800-9ba35011f416", "5955ee8d-4df9-4e80-9194-3445be9596e2", "b03d91f8-e690-4307-b09f-6bdce66c1d24"] }, // 台新台灣高股息基金
  { sourceId: "204", fundIds: ["3d2ff21f-3ebb-400f-b0ca-7578dababb18", "5f1cbbba-a0fd-45eb-bffd-53fe1fc00bb9", "1978e41c-1bf8-41f3-9b9c-3d155ffa64a5", "62a70924-7fc6-4e6d-917a-a4c5248580d6", "38471d08-48eb-406e-b625-0a44b86dc91d", "a61dbe24-14b6-4e2b-89f0-2a104824fcc2", "12566736-bde5-4629-a1e3-2a472dff8de2", "ae1794c2-b5e8-488c-b6b8-b5cbd4ac3b40", "870e3aad-4e3e-4c1e-b196-69e848a7172e", "3f830037-5f34-4c80-ae66-fe8ab98a9a2e", "f0d2c4d4-0294-4724-a538-f44f222dfcbb", "1154818d-86d5-4735-a910-ed01c67565a6", "b12cc360-ff09-444d-9451-6f3d84189b79", "72c3beed-58e6-4998-bd12-005c8b2e3662", "acc37ed1-176c-4a12-8328-9ff97d77bcbb", "13202a13-ebce-40c1-9f77-ba1e87c4584f", "09c804ef-668d-41e7-9e1f-5fb0023a1107"] }, // 台新新興短期非投資等級債券基金
  { sourceId: "172", fundIds: ["57984a00-0dc3-4eb4-bdc9-29f7ce7f9446", "d27b33bc-479b-4f9f-93d6-29e6640057c8", "0ac98b83-ef3c-44bf-914e-88a5588c7ed3", "eb62089f-467d-4975-92b9-776c09638f66"] }, // 台新智慧生活基金
  { sourceId: "487", fundIds: ["ebc86ab2-8f58-4294-8a03-ec61fb24a39a", "d659c642-9a62-43c3-9fc9-e3336a2eb17d", "621c14ac-3ecd-47e3-a105-303a16eac826", "a49fb5a7-eb75-4d6f-b610-82d5659a6c14", "4c219987-ab4c-4f4f-bf0f-41699fc44bb9", "5e32b425-122b-4835-b087-cd4b0e895d2f", "6e3932d4-4904-482f-8b0f-a0f969db173b", "1e246cde-9b5d-4ea2-8feb-bcf8998b02ad", "f49737bd-9d16-44b7-9029-846a871a2690", "5c2a79dc-d333-470a-8ca3-d41864239075", "fd5ff164-e755-40a0-80e3-391747049ffc", "36c70057-0124-4555-ab3e-f0b7d58e8213"] }, // 台新美國標普日常消費品精選行業指數基金
  { sourceId: "240", fundIds: ["060645a6-03ee-4a33-8314-5e842878c6d4", "9c134224-2f9b-4e23-85f4-4f364186cb4f", "f91baeb0-a443-44ea-ae5d-34249644ed0e", "72823b0d-706e-4023-8e9d-b536910d159f", "3fd25ad0-31a5-4be9-9436-2e10726cf7b4", "0fa612ac-a7fd-468c-855a-2864d595f1be", "e1e42c9f-99cb-4982-8cb3-cd996b470807", "8699ff02-2e7c-4a0a-b574-dada47bffe87", "40f31987-da72-4d1a-9dc2-ccd3f79d4d4b", "37e99668-840e-4edc-9ae0-72f4b72b01f6", "cf3418b9-c8d6-48fe-8295-b0495da8877c", "13468f63-9220-456f-b31a-527cbcf37d86", "f2b46dc3-14ff-42f7-a9cb-aaeaf9422fd9", "c599f098-cde8-4fe6-96c1-4a54bdae1e15", "d86612e9-2a66-4947-b667-97a308ec569f", "1b2a8c7d-478b-46c6-be0d-dbb19ec7383e", "6c527c21-7795-49f0-a3ff-cb07c2bb4bfb", "cda13c6a-2bed-4607-be5e-e0ed8a652360", "e6d63560-1eb2-4689-b3d4-62cb6cc7ee86", "9695f8fb-9554-404a-ac63-27cd92bd26d0", "702db40b-a9ba-4f87-8dba-8fd64e40e806", "718cc151-dcf0-4da8-8da6-ec30852aeb8d", "259896f2-8669-446f-bc10-7fa49594b090", "2e62ea1c-2a2a-47ed-aa92-5b0729de6a8b", "c1d9119a-5a98-4e6d-94c7-7ad83983bbe7", "e46e03b1-6c7b-4ba3-8713-83010a8ee89c", "79dfc547-7e8d-4130-b8af-7035e923077e", "fb72b1f2-8f94-41a9-a386-fc45f63b466e"] }, // 台新ESG新興市場債券基金
  { sourceId: "186", fundIds: ["859cb7e6-e00e-4e9d-b973-972b7e367eac", "2877c741-d302-4db4-96f6-28701744dee3", "9bc5fb7c-a2eb-4116-a213-707026d63ad9", "31432190-9ff6-411b-a7ff-2224bf3ca569", "abb3cd8c-ba4c-435e-9ff7-91d5534fbc7a", "a10ebb0d-9bd2-41a4-b9c0-106d9511ba1f", "3aac74e9-5e28-43f1-ac79-a78f620ccd8c", "d579cb8d-19c3-4b94-8c44-3131f317b17e", "b867e052-e72c-4147-9560-16b96e41c21f", "b675a391-2158-4e07-ae5a-fd509fe2f17c", "019d3940-1fda-491f-9be4-f20b0a08aa80", "c14b5d90-792c-484e-88ff-5e57c0ce478b", "57e68fe1-870f-4baf-8e40-d6a59b19117d", "9fb561ff-ef12-4370-862e-fbd448bce474", "5f3c51cd-5677-4fa1-ac60-a481984619b2", "69435c54-850f-4047-a87a-9e1f31ee547a", "b12bd070-3f22-4948-921d-d597aca0e468", "d4f503a9-0011-4a26-bbab-7cdbb6d577be", "96f59f76-f0db-49b6-bb50-d52d8146107c", "f06d6b40-fe0b-48ae-8fea-14f0aea1cc04", "b914ead9-0ee2-422e-a861-6b0d6b7877a9", "8c9ba9fa-9b61-4bf5-8460-047d651fe552"] }, // 台新優先順位資產抵押非投資等級債券基金
  { sourceId: "150", fundIds: ["82f74cd3-b63d-4c93-ae05-4571a4c6812e", "341316e5-4f1b-40b3-af84-c2ef913fa816", "c2a4342a-cc84-483f-8ced-80b568de96bd", "600ab08d-0109-4bc1-a2cb-21bdfd72cedb", "f97a23f6-a0ba-4f9b-8267-e01076d7bfdd", "74e6fae1-ec80-4ff9-9bd0-54f67f7a5862", "87fdd56e-d383-4adc-9549-37fd7d2fe0f1", "78e91510-153f-4e3f-b530-078809871cc4"] }, // 台新全球多元資產組合基金
  { sourceId: "370", fundIds: ["2589f84e-29d1-4b7a-b4b6-65949570f518", "0b24b92a-e24f-4e71-ba51-16c20fc24b3f", "cde674f6-8025-4843-ad90-8a335f13aa81", "4558b50c-fe4c-40f3-ad7c-70727afd034b", "96d03c6b-fc91-4c07-ba32-3795c687d8dc", "422d766f-b9ac-442b-94bc-b86af21c0dba", "b31cd6d2-0633-4280-bffa-f8aebcf6881e", "366bdc62-b739-4d9d-aab5-6014b345c3d2", "59707707-c5af-464e-bc8c-bcb91154255a", "112ed14b-6bdc-4a11-9317-b600d2855a4b", "9f936aac-d40a-44a5-a78d-ed74dbe3b918", "4c6f0f99-9f34-4a13-ad25-270c1f7dc8c9", "cc416686-a027-44e1-a1bb-0a94440121b1", "82c531d1-9849-4618-8b72-72bb46bde611", "a8ca8048-13ab-4428-8383-8114a5e2ead1", "d5b874c2-da72-40fa-af70-cb484acc594d", "c8aa8922-d3ab-4f45-8fd8-7a4efb768e90", "c6f81b94-102e-4cf8-abdf-a700c201acf9", "a9500257-a45a-4254-92cf-008cc1bb9a15", "d3cc589c-460b-4839-b283-0b1d4505cead", "ef69ef05-21c4-493d-a2d9-9680f026f9d5", "ad674e85-dc7b-48c3-9edd-6331fea12f6f", "4460665c-6cae-4b26-a99e-46803fe5a32a", "0c78e67b-e5ad-41d2-a138-0fb1376a03ea", "db862d05-1643-446e-aeb6-3112ab6d6f7d", "9162c630-d37b-4da6-8302-271f26a7d3e1", "ba4fc72e-11ca-45e1-b5a2-799f9017a6d1", "60af7e71-655e-4fed-a97a-a2a6a1281b7a", "981e5e85-2110-42f2-8017-be1994572407", "5ed0eb03-a326-42a1-ac27-2fc1fe045525", "1b2affa6-62f7-4a9b-93c1-298f705d2c84", "3b49dada-d1f9-4c01-acfe-891c926f6622"] }, // 台新收益領航多重資產基金
  { sourceId: "470", fundIds: ["d4b97ae8-45de-4a8e-ae44-877475fabb94", "729cc6ab-a3a5-478b-96ba-4cdd9d5d7bd5", "b777c98d-2c06-48ba-9fcc-71b22dc6d350", "1562a4ef-696c-4cc0-b0a1-ff0e18a1a2ed", "8308665b-8009-4a42-a31e-d44ef14b44af", "7dca1971-53e8-401f-b792-55e8bdf68eae", "ee42c11e-5aaf-42c0-8218-db48d6b6921c", "4ccacb9d-0476-4a88-a603-16fa33af90fd", "4107a47a-84c6-4752-ad34-8124e9587db0", "4086572c-cc29-4957-ba70-30860d9c63b2", "01cf0d6c-685e-4758-b7b8-dcd662de1380", "cfc276fd-bd4d-4982-a931-5c34d01f0054", "0a058f42-03cf-4a1e-ac54-ab02be9342bd", "c0e4d6e1-c686-4535-a82a-ab5b71e5ed2d", "250b8aec-7e9a-4550-a9cf-70edbefff0e5", "639c84ac-41ad-4ecd-8f13-423bdd5cf1bf"] }, // 台新全球多重資產基金
  { sourceId: "403", fundIds: ["0e74ec1b-dd98-42a9-bbae-b3fdb0d64bc8", "844b78db-98be-41e5-9b88-ede9207e49e9", "8a5114e7-090f-43bc-b281-6206f1af9849", "75db170a-5f1a-4822-adb0-ae6a7514a2d1"] }, // 台新全球生技醫療基金
  { sourceId: "428", fundIds: ["a4a1403d-6ac8-4e3b-ad5e-b9c75d868466", "9cf5f38f-e72c-4cd0-a389-4bb3cd6781e6", "01888bf9-95f6-40b6-937e-289969235883", "34cecb87-5115-43ff-9419-0dcdbb2c0ca8", "a26efbf2-c49c-47ec-97c7-1751c7250302", "9a81fb2b-0798-4e3d-81bf-17b2e9a78b29"] }, // 台新全球特別股收益基金
  { sourceId: "401", fundIds: ["d6ffad8e-1f5e-4843-b412-70ac03b1aa7b", "621b0f73-d4aa-4d81-a2e8-442b43d09bd4", "5a863d15-a788-4865-aa86-8ff16879f5a1", "9d815682-05e0-4aba-9f4b-4f6600993fc4", "9c615125-8e49-41de-9ccc-91aee40f1b19", "46a989a8-4634-4002-ab44-a9bdb8a60e49", "e4a0cf9f-0727-42a2-a769-a56c3b1e80c6", "8187af1f-b29a-40df-b66c-b3581b22293c", "86240a7b-df1e-421a-ae09-c7a188240b2e", "fa534e23-4931-4155-9efe-966580bb7751"] }, // 台新美國豐收平衡基金
  { sourceId: "435", fundIds: ["d29db766-f4a5-4316-8302-7e2f79f96e5f", "044ebba0-b714-4094-8044-4eeac029e5aa", "16023004-ddb1-4e33-9b59-0b37d42f8b16", "6dcc82c2-8428-4ef0-876e-4f232d48a329", "8ac1018e-0b0c-4801-836f-902d0cb7a54d", "25113822-cfbb-4a85-80c0-b2ba13ffbc9e", "f21e4093-a6b3-4a7a-9354-347547b28982", "342b0efe-17e0-468d-a5b0-dab60e54e188"] }, // 台新新興富域國家債券基金
  { sourceId: "229", fundIds: ["0d683f42-fb25-486c-acf1-f2aff0881562", "f6ca1dac-0d28-4661-8d9e-1693b890210b", "225f66f6-82e3-4ac0-b1f1-2317ce3b6b29", "fb9cfb3e-5fc0-44d9-aef0-5f549d4b0c42", "6fb7c332-d0d8-4833-bc02-8463b2fc884c", "d755a9d3-2fe6-409e-9f55-b02c00b1f63d", "74e82607-d51b-49ca-99ca-af0fd9a5cf5a", "bd06887f-2d6f-4e3f-a133-bc9db69c54b3", "bd920c7d-cdbe-4a44-96ee-c36bff41432a", "3de6f761-2fc3-4b2f-963c-48a0ea860694", "79ff1cb9-8e8d-4637-9934-e45101588d4c", "a640060b-1942-486b-8b10-07c7451ff980", "0b97a3c3-039d-4061-9eda-892f3173be9d", "cb85475e-16a8-4800-b137-96b5d72b7334", "e069907c-874c-4518-91ed-f314512112bf", "d5e70322-8d18-4968-a651-978c9b83aaac", "3b09ff00-0fb6-45a9-a8f2-4e40ff6ab6f9"] }, // 台新策略優選總回報非投資等級債券基金
  { sourceId: "308", fundIds: ["47a563ea-923a-48f0-a69a-5c0debd31be6", "667aa733-1197-4bab-8602-fedf19c99fdd", "1a4097bd-4359-487c-9381-4e672323c150", "473c535c-ece1-4666-bae0-c64607ee4294", "8a0f17ed-3648-4937-a9d3-90b1bd57bbe8", "a109f233-1854-4958-bb56-f03b96938b81", "1a4462d8-c045-4de3-8035-bf1e8ff946b5", "219c9111-2ed0-4a5b-8028-87409f1b2614", "93db92cf-ec71-42f3-99ea-6d2986c86cf0", "b50af86a-fcb7-4fa4-988c-05400a32add2", "66c8393b-6df8-48b1-8862-efadf8fcd525", "2d37fc79-7055-4b48-8a2b-4631439e6c11", "9ab76854-50c2-471c-9afe-94a23c15cf51", "de7ac7de-d20b-4ce0-8b65-be8b50f97b22", "a07016a0-c5c3-4e31-a42b-6ab3071c8a28", "24d789b4-b373-45f7-a5dc-a416f253855d", "b42c09b0-b821-4d25-ba6a-e3b30c47362b", "1364ce79-eb0b-4953-983d-14b57e9974b9", "6ac02f68-0905-4b5b-8003-505e0bb6337e", "70972576-85fa-4880-9a66-09443e9918d4", "6b44f1c5-9fa6-44ce-893f-e3643b6145d1", "fe451642-4cd2-4b6c-a1c6-3e47e309f488", "22a55e25-763e-4ff4-b387-cbcda0acfd73", "4787dcab-d0fd-430c-8d9c-974533149b64", "ce73d25d-5dd6-40eb-9ef2-903a9a8f86c8", "4365ac41-23d6-4c9a-86c2-8db5f8c50fcb", "a9a65dd9-80e6-4e25-a31f-8609cf895ee8", "41192d40-01de-4dab-989e-e7c9b6e60021", "d6e7b206-cd27-4f06-b070-2f374c516a0c", "2690cd65-6d63-4322-a6e7-e31bfa471ccb", "8f445ee1-a26f-4e9d-af15-1087218c652a", "c5d96cc0-7c50-4789-817f-8d670f03a2bb"] }, // 台新美國策略時機非投資等級債券基金
  { sourceId: "407", fundIds: ["1a417b76-68b5-4546-bce0-498d0f567ef3", "2bc50645-b317-400e-b3fd-a28c6f2e54d3", "67137b91-466f-4da3-b219-534b74b58a5c", "12c99d5d-6827-42ad-a11b-4580f496066b", "0558eff6-c5f1-49ae-a594-e6f3644777af", "e3202ee7-16e1-4923-ab0f-c6dc854f3642", "a3fe9d3c-7619-4a18-91a5-e1f3ea5c3a3e", "97851329-068e-4dce-80da-01e7ed4c0ec5", "b6885ad8-f5e0-475a-87d5-a7faebecf10e", "e2cbc68c-a6df-4776-8217-f97af0bec425", "6692f971-f6bb-4ee4-b3e2-e6fafe48ada0", "a41d56fc-de5a-47fd-999e-ea6403418d69", "3154ecad-b4e6-401f-8ab2-04dc4e968126", "b472976f-8778-484c-b007-01a1401a5254"] }, // 台新全球債券基金
  { sourceId: "476", fundIds: ["2d6a63e7-732d-44cf-8585-5c5dffaf0a11", "2931bae1-d77d-430c-adb4-329d5973ce34", "175fd188-7c01-46ae-8370-523e950fbe0f", "9569c286-4be1-4b74-9578-863964be8878"] }, // 台新四年到期美國投資等級債券基金
  { sourceId: "339", fundIds: ["d8bcd8c8-2b7b-478f-9914-c76b688e2e90", "da2a858f-08d5-42e6-b656-39c348fa932e", "4dc23caa-d5c0-4f3e-8a25-5db69e745a09", "5ee6a836-eaf5-4674-b069-05bd30fdc3bf", "69167523-0dc1-4477-b4f6-c6724966ff2b", "fa3a9eff-5b27-40f1-9765-fdd7e483b9a1", "c726cca2-e520-404f-859c-ece712360eaa", "8ad5f715-c1bc-4b7f-9359-2858e19a1411", "12d63d72-4498-4989-90d7-3a5ae01e65a8", "e3181a05-fecf-44fb-8699-3f5fcc1315d7", "fcc8122b-03c0-43b8-855a-d2ba8655f3fa", "9955c47c-aa4a-4c8b-b922-dbd5620349fb", "cd00dfe5-3e4c-47ac-b9f4-c766a5fa57a4", "ab663024-b2d4-4512-b176-c5e53c85f2b3", "3a6de1c4-e660-4eaf-b72d-2cd64643dd0e", "f199a2fc-d73d-4e05-8470-72d3e8caab50", "6642e7b1-57eb-45eb-bed9-fe1591729fa5", "21663067-d9d6-464e-8fba-bfad2381ad8c", "6802cd5c-f53c-4af8-8a2a-2e0227a35720", "9aee13e7-8309-4842-b0fe-5facca1200c9", "4fb7b6de-1b31-4a91-8dc4-b6c23e045216", "66990851-60d5-4814-90d7-0ed4add5db50", "092a8526-be5d-49f6-89a1-5cd132783e10", "a4d0aa1e-b49f-4286-b9d4-410608cc9102", "3dcc88c1-06ec-49ee-b3f1-19be97c27eb2", "d72987c7-1dfd-415b-9ac0-ed8635dff301", "5a53a738-55ac-4417-a401-67440ed23126", "eebdbac7-fb2e-4a35-bdd9-11546d7e06d0", "68a16eb8-3cf5-4269-a2e2-f4da6433612a", "dbc9ebfd-8723-4aed-b5dc-b7e12dc835dc", "5fb2360d-5cde-4bae-9ac7-14d6035f2370", "a76087dc-ba9b-4a1b-99f7-d3c143c6cfde", "8d4b77d6-2d46-4782-a198-b86c8baed40a", "73006b8e-2414-4f46-9a74-2ec617328608", "e6666e63-74ee-40aa-828d-88b19706f4e8", "fac95f50-0da5-441e-b154-e8675b94307e"] }, // 台新靈活入息債券基金
  { sourceId: "103", fundIds: ["d9ba3670-68f7-4f7b-86b6-09c1b67d8fb5"] }, // 台新1699貨幣市場基金
  { sourceId: "388", fundIds: ["fa6d621f-75d2-44f2-9869-760c543a4b9b", "bf7206d5-4c25-425e-97cd-c084c7e99e0a"] }, // 台新吉星貨幣市場基金
  { sourceId: "102", fundIds: ["bc67a789-5a83-48bb-a1bd-fbc22294d9e1"] }, // 台新大眾貨幣市場基金
];