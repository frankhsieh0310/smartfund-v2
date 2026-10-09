import assert from "node:assert/strict";
import { classifyOwnership } from "./database-checkpoint-adapter.ts";
assert.deepEqual(classifyOwnership(0), { ownerActive: false, ambiguous: false });
assert.deepEqual(classifyOwnership(1), { ownerActive: true, ambiguous: false });
assert.deepEqual(classifyOwnership(2), { ownerActive: false, ambiguous: true });
console.log("database checkpoint adapter tests passed");
