// Pure command-text parsing — no I/O, fully unit-testable without a live bot token.

export type ParsedCommand =
  | { kind: "reports" }
  | { kind: "pending" }
  | { kind: "approve"; postId: string }
  | { kind: "reject"; postId: string }
  | { kind: "hide"; targetType: "POST" | "REPLY"; targetId: string }
  | { kind: "delete_request"; targetType: "POST" | "REPLY"; targetId: string }
  | { kind: "suspend_request"; profileId: string; duration: "1D" | "7D" | "30D" }
  | { kind: "ban_request"; profileId: string }
  | { kind: "help" }
  | { kind: "unknown"; raw: string };

const TARGET_TYPES = new Set(["POST", "REPLY"]);

export function parseCommand(rawText: string): ParsedCommand {
  const trimmed = rawText.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0]?.toLowerCase();

  switch (command) {
    case "/reports":
      return { kind: "reports" };
    case "/pending":
      return { kind: "pending" };
    case "/approve":
      return parts[1] ? { kind: "approve", postId: parts[1] } : { kind: "unknown", raw: rawText };
    case "/reject":
      return parts[1] ? { kind: "reject", postId: parts[1] } : { kind: "unknown", raw: rawText };
    case "/hide": {
      const targetType = parts[1]?.toUpperCase();
      if (targetType && TARGET_TYPES.has(targetType) && parts[2]) {
        return { kind: "hide", targetType: targetType as "POST" | "REPLY", targetId: parts[2] };
      }
      return { kind: "unknown", raw: rawText };
    }
    case "/delete": {
      const targetType = parts[1]?.toUpperCase();
      if (targetType && TARGET_TYPES.has(targetType) && parts[2]) {
        return { kind: "delete_request", targetType: targetType as "POST" | "REPLY", targetId: parts[2] };
      }
      return { kind: "unknown", raw: rawText };
    }
    case "/suspend1d":
      return parts[1] ? { kind: "suspend_request", profileId: parts[1], duration: "1D" } : { kind: "unknown", raw: rawText };
    case "/suspend7d":
      return parts[1] ? { kind: "suspend_request", profileId: parts[1], duration: "7D" } : { kind: "unknown", raw: rawText };
    case "/suspend30d":
      return parts[1] ? { kind: "suspend_request", profileId: parts[1], duration: "30D" } : { kind: "unknown", raw: rawText };
    case "/ban":
      return parts[1] ? { kind: "ban_request", profileId: parts[1] } : { kind: "unknown", raw: rawText };
    case "/start":
    case "/help":
      return { kind: "help" };
    default:
      return { kind: "unknown", raw: rawText };
  }
}

export const HELP_TEXT = [
  "可用指令：",
  "/reports — 查看待處理檢舉",
  "/pending — 查看待審核的首篇文章",
  "/approve <postId> — 核准首篇文章",
  "/reject <postId> — 退回首篇文章",
  "/hide POST|REPLY <id> — 隱藏內容（立即執行）",
  "/delete POST|REPLY <id> — 刪文（需按確認按鈕）",
  "/suspend1d、/suspend7d、/suspend30d <profileId> — 暫時停權（需按確認按鈕）",
  "/ban <profileId> — 永久停權（需按確認按鈕）",
].join("\n");
