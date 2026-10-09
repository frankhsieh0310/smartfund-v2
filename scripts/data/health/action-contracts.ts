import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export type ActionContract = Record<string, any> & { contract_id: string; dataset_key: string; status: "EXECUTABLE" | "PARTIAL" | "BLOCKED"; confidence: "HIGH" | "MEDIUM" | "LOW"; enabled: boolean };
export const ACTION_CONTRACT_PATH = resolve("config/global-data-self-healing-action-contracts.json");
export async function actionContractMetadata() { const bytes = await readFile(ACTION_CONTRACT_PATH); const document = JSON.parse(bytes.toString("utf8")); return { version: document.version, checksum: createHash("sha256").update(bytes).digest("hex"), count: document.contracts?.length ?? 0 }; }
export async function loadActionContracts(): Promise<ActionContract[]> {
  const document = JSON.parse(await readFile(ACTION_CONTRACT_PATH, "utf8"));
  if (document.version !== "1.0.0" || document.maxAttempts !== 3 || document.arbitraryShellExecution !== false) throw new Error("ACTION_CONTRACT_ROOT_POLICY_INVALID");
  if (!Array.isArray(document.contracts) || document.contracts.length < 13) throw new Error("ACTION_CONTRACT_COUNT_INVALID");
  const ids = new Set<string>();
  for (const contract of document.contracts as ActionContract[]) {
    if (ids.has(contract.contract_id)) throw new Error(`ACTION_CONTRACT_DUPLICATE:${contract.contract_id}`); ids.add(contract.contract_id);
    if (contract.enabled && (contract.status !== "EXECUTABLE" || contract.confidence !== "HIGH" || !contract.resume_command || !contract.checkpoint_path)) throw new Error(`ACTION_CONTRACT_UNSAFE_ENABLEMENT:${contract.contract_id}`);
    if (contract.enabled && contract.resume_command?.command && contract.resume_command.command !== "node") throw new Error(`ACTION_CONTRACT_COMMAND_NOT_ALLOWLISTED:${contract.contract_id}`);
    if (String(contract.resume_command?.args ?? "").match(/\b(rm|del|truncate|migrate|reset|backfill)\b/i)) throw new Error(`ACTION_CONTRACT_DESTRUCTIVE_COMMAND:${contract.contract_id}`);
  }
  return document.contracts;
}
