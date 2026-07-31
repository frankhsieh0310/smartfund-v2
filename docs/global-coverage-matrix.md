# Global Coverage Matrix

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
