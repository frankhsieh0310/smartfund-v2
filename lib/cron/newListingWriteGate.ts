// Same shadow-mode pattern as lib/cron/commodityWriteGate.ts / indexWriteGate.ts / cryptoWriteGate.ts
// — default OFF, only the exact string "on" opens it. Gates BOTH the product_listing_events insert
// and any auto-provisioning (new etfs row) / delisting flip (is_active=false) this pipeline performs.
export function isNewListingSyncWriteEnabled(): boolean {
  return process.env.NEW_LISTING_SYNC_WRITE === "on";
}
