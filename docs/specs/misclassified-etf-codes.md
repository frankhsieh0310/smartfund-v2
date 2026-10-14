# 誤列為 ETF 的證券公司資料 — 規則過濾

2026-10-14，QA round 4，對應指示六。

## 背景

原本用一份手動維護的 6 碼清單（`020000/020012/020028/020030/020031/020034.TW`）隱藏這些誤分類資料，
使用者發現 `020001.TWO`（Fubon Securities Co Ltd）不在清單裡——證實「逐筆加清單」的做法本質上就會漏，
照指示改用規則。

## 規則（`lib/data-platform/web/etfService.ts`）

```sql
code ~ '\.(TW|TWO)$'
AND (name ILIKE '%securities%' OR name LIKE '%證券%')
AND name !~* 'etf|fund|trust|index'
AND name !~ '基金|信託|指數'
```

**試過但放棄的規則（VERIFIED 不可行）**：
1. 純代碼前綴規則（`020xxx`）——**太寬**：`020032.TW`（元大綠能ETF，真實商品）也會中招；若不限定 `.TW/.TWO`，
   還會誤殺幾十檔真實的韓國 ETF（代碼同樣以 `02` 開頭，例如 `0203D0.KS`、`0219E0.KS` 等）。
2. Yahoo 自己的 `instrumentType` 欄位——查證過，Yahoo 自己也把這些證券商代碼標成 `"ETF"`，這個欄位本身
   就是錯的，不能當依據。
3. 單純「名稱含 Securities／證券」——**太寬**：幾乎所有正牌台股 ETF 的官方全名都含「證券投資信託基金」
   （法規慣用全銜），國際 ETP 也有些合法商品名稱本身就包含「Securities」一詞。

## 規則抓到的全部代碼（VERIFIED，2026-10-14 即時查詢，共 17 檔）

| 代碼 | 名稱 |
|---|---|
| 020000.TW | FUBON SECURITIES |
| 020001.TWO | Fubon Securities Co Ltd |
| 020012.TW | FUBON SECURITIES |
| 02001L.TW | FUBON SECURITIES |
| 020020.TW | YUANTA SECURITIES CO.LTD |
| 020025.TWO | UNI-PRESIDENT SECURITIES CO LTD |
| 020028.TW | YUANTA SECURITIES CO.LTD |
| 020029.TW | YUANTA SECURITIES CO.LTD |
| 020030.TW | PRESIDENT SECURITIES |
| 020031.TW | PRESIDENT SECURITIES |
| 020033.TWO | PRESIDENT SECURITIES |
| 020034.TW | YUANDA SECURITIES CO.  LTD. |
| 020036.TW | YUANTA SECURITIES CO.LTD |
| 020037.TW | YUANTA SECURITIES CO.LTD |
| 020038.TW | YUANTA SECURITIES CO.LTD |
| 020039.TW | YUANTA SECURITIES CO.LTD |
| 020041.TWO | MEGA SECURITIES CO.  LTD. |

全部都是台灣證券商自己的股票代碼（富邦證券、元大證券、統一證券、群益證券、兆豐證券等），不是任何
真實 ETF 商品。相較舊的手動清單（6 檔），這個規則多抓到 11 檔先前沒被隱藏的誤分類資料，且往後若有
新的同類資料被誤標成 ETF，規則會自動抓到，不需要再手動加清單。

**資料庫未被修改**——這些資料列仍存在 `etfs` 表，只有顯示層（App／網站的 ETF 清單與搜尋）隱藏它們，
與既有的「重複 ETF」隱藏邏輯（`getSuffixedDuplicateCodesToHide`）採用同一種做法。
