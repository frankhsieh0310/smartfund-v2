# U.S. Treasury Individual Bond V1 Schema Gaps

The deployed production database has no individual-bond detail, auction-event, lifecycle-event, source-document, or bond-failure tables. No Prisma schema or database migration was performed for this V1.

## Safely persisted now

The existing `securities` table stores the deterministic internal ID, internal ticker, CUSIP, name, issuer label, country, currency, bond-type classification, and `US_TREASURY` market boundary.

## Preserved outside canonical tables

Each run archives the official raw pages plus normalized instruments, auction history, lifecycle events, and the canonical preview. These archives preserve issue and maturity dates, coupon terms, auction price/yield observations, source update dates, raw checksums, and lineage until a separately reviewed schema change is approved.

## Missing canonical persistence

- structured issuer and source identity
- issue, original issue, maturity, and dated dates
- coupon rate, coupon type, payment frequency, and term metadata
- offering and outstanding amounts
- auction observations and lifecycle events
- latest official auction price/yield and source timestamp
- raw payload checksum and archive reference
- record-level failure and supersession lineage

## Explicitly unavailable from this source

The official auctions dataset is not a secondary-market feed. It does not supply daily clean/dirty price, bid/ask, trading volume, daily YTM/YTW, spread, duration, convexity, or DV01. Government yield curves must remain separate and cannot fill these fields.

CUSIP is stored for internal identity matching only. External redistribution remains gated pending a separate CUSIP reuse review.
