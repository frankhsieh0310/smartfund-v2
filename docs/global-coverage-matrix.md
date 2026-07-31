# Global Data Coverage Matrix v2

Snapshot: 2026-07-31 22:20 Asia/Taipei. Evidence is the read-only production audit of stock master, price history, lifecycle tables, and committed daily-job configuration. Statuses: **Complete** = production evidence; **Partial** = real but incomplete data; **Prototype** = limited proof/schema only; **Not started** = no production evidence.

| Data type | TWSE | TPEx | NASDAQ | NYSE | AMEX | Japan | Korea | Hong Kong | Canada | Australia | Germany | France | UK | Spain | Italy | Netherlands |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Universe | Complete (1,088) | Complete (889) | Complete (3,581) | Complete (2,635) | Complete (288) | Complete (3,845) | Complete (2,672) | Complete (9,586) | Complete (4,797) | Complete (3,607) | Complete (10,010) | Complete (9,661) | Complete (5,948) | Complete (200) | Complete (10,055) | Complete (2,442) |
| Daily price | Complete | Complete / run active | Partial / prior validation | Partial / prior validation | Not yet executed | Run started | Not yet executed | Not yet executed | Not yet executed | Not yet executed | Not yet executed | Not yet executed | Not yet executed | Not configured | Not yet executed | Not yet executed |
| Historical price | Complete | Complete | Complete (99.97%) | Complete (99.92%) | Complete (99.65%) | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete |
| Adjusted close | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete |
| Volume | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete |
| Corporate action | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype | Prototype |
| Financial statements | Prototype | Prototype | Partial / SEC-oriented | Partial / SEC-oriented | Prototype | Not started | Not started | Not started | Not started | Not started | Not started | Not started | Not started | Not started | Not started | Not started |
| Financial ratios | Partial PE | Partial PE | Prototype PE | Prototype PE | Prototype | Not started | Not started | Not started | Not started | Not started | Not started | Not started | Not started | Not started | Not started | Not started |
| Daily scheduler | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | **Not started** | Complete | Complete |
| Historical backfill | Complete | Complete | Partial exceptions | Partial exceptions | Partial exception | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete | Complete |
| Quality validation | Complete daily run | In progress | Prior PASS | Prior PASS | Lifecycle ready | Lifecycle ready | Lifecycle ready | Lifecycle ready | Lifecycle ready | Lifecycle ready | Lifecycle ready | Lifecycle ready | Lifecycle ready | Not configured | Lifecycle ready | Lifecycle ready |
| Production ready | Yes | Pending current run | Partial | Partial | No runtime proof | No runtime proof | No runtime proof | No runtime proof | No runtime proof | No runtime proof | No runtime proof | No runtime proof | No runtime proof | No | No runtime proof | No runtime proof |

## Reading the matrix

- **Historical price**: 71,300 of 71,304 audited symbols have canonical backfill evidence (99.994%).
- **Daily price**: a configured scheduler is not treated as completed execution. Only TWSE has the current completed run proof. TPEx and Japan were actively running at this snapshot; NASDAQ/NYSE had prior validated completion-skip evidence.
- **Corporate action and financial data** are cross-market capabilities, not completed per-market datasets. The table prevents the price engine's high coverage from being misrepresented as financial coverage.
- The only missing market scheduler in this scope is Spain (`MCE`).

## Field lifecycle matrix

`Historical backfill` and `Incremental update` are separate gates. A field is not complete until canonical storage, historical ingestion, incremental execution, validation, and Production evidence all exist.

| Field family | Schema | Historical backfill | Incremental update | Validation | Production | Actual evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Trade date, OHLC, adjusted close, volume | Yes | 99.994% of audited stock universe | Active by isolated market job | Lifecycle + provider validation | Partial global rollout | 71,300 / 71,304 canonical backfill markers |
| Revenue through book value per share | Yes, generic facts | **Pilot passed: 5 symbols** | **Pilot passed: 5 symbols** | Numeric, period, provenance; global statement validation pending | No global Production run | 4,501 Yahoo statement/event facts inserted in Phase 2 pilot |
| Cash dividend / split ratio | Generic facts only | **Pilot passed: 5 symbols** | **Pilot passed: 5 symbols** | Source/key/date + idempotency; event reconciliation pending | No global Production run | 309 dividend and 55 split facts across five pilot symbols |
| Corporate-action dates and non-Yahoo event types | No dedicated event schema | No | No | No | No | Record/payment dates, rights, mergers, renames, delistings remain absent |
| Market cap, EV, PE/PB/PS and ratios | Generic facts support storage | PE partial only | No global incremental calculation | Prototype only | No | Taiwan PE 97 stocks; US point-in-time PE 3-stock proof |
