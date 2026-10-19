/**
 * One short line describing a tool call for timelines: the shell command for
 * Bash, the file for Read/Edit/Write, the first string field otherwise.
 */
export function summarizeToolInput(name: string, input: unknown, max = 120): string | null {
  if (input === null || typeof input !== "object") return null;
  const p = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof p[k] === "string" && (p[k] as string).trim()) return (p[k] as string).trim();
    return null;
  };
  let text: string | null;
  switch (name) {
    case "Bash":
      text = pick("command", "description");
      break;
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      text = pick("file_path", "notebook_path", "path");
      break;
    case "Grep":
    case "Glob":
      text = pick("pattern");
      break;
    case "Agent":
    case "Task":
      text = pick("description", "prompt");
      break;
    default:
      text =
        pick("description", "query", "url", "pattern", "command", "prompt") ??
        Object.values(p).find((v): v is string => typeof v === "string") ??
        null;
  }
  if (!text) return null;
  text = text.replace(/\s+/g, " ");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
