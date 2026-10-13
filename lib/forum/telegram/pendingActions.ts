// Encodes/decodes the destructive actions that require a confirm-button tap (刪文、停權、永久停權)
// into Telegram's callback_data (max 64 bytes, plain string — no server-side session store needed
// since the whole action fits in the button itself, and only the whitelisted admin chat can trigger it).

export type PendingAction =
  | { kind: "delete"; targetType: "POST" | "REPLY"; targetId: string }
  | { kind: "suspend"; profileId: string; duration: "1D" | "7D" | "30D" }
  | { kind: "ban"; profileId: string };

const PREFIX = "confirm:";

export function encodePendingAction(action: PendingAction): string {
  let payload: string;
  switch (action.kind) {
    case "delete":
      payload = `delete:${action.targetType}:${action.targetId}`;
      break;
    case "suspend":
      payload = `suspend:${action.duration}:${action.profileId}`;
      break;
    case "ban":
      payload = `ban:${action.profileId}`;
      break;
  }
  const data = PREFIX + payload;
  if (Buffer.byteLength(data, "utf-8") > 64) {
    throw new Error("callback_data exceeds Telegram's 64-byte limit");
  }
  return data;
}

export function decodePendingAction(callbackData: string): PendingAction | null {
  if (!callbackData.startsWith(PREFIX)) return null;
  const parts = callbackData.slice(PREFIX.length).split(":");

  if (parts[0] === "delete" && (parts[1] === "POST" || parts[1] === "REPLY") && parts[2]) {
    return { kind: "delete", targetType: parts[1], targetId: parts[2] };
  }
  if (parts[0] === "suspend" && ["1D", "7D", "30D"].includes(parts[1] ?? "") && parts[2]) {
    return { kind: "suspend", duration: parts[1] as "1D" | "7D" | "30D", profileId: parts[2] };
  }
  if (parts[0] === "ban" && parts[1]) {
    return { kind: "ban", profileId: parts[1] };
  }
  return null;
}

export const CANCEL_CALLBACK_DATA = "cancel";
