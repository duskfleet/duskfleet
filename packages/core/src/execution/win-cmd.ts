/**
 * Spawning a Windows batch shim (`copilot.cmd`, the file npm installs for a global package).
 *
 * Since the fix for CVE-2024-27980, Node refuses to spawn a `.cmd` / `.bat` with `shell: false`
 * (EINVAL): a batch file always runs under `cmd.exe`, which re-parses its command line. So a shim
 * goes through `cmd.exe /d /s /c "<line>"` with every argument quoted and its cmd metacharacters
 * caret-escaped twice (once for this `cmd.exe`, once for the shim's own `%*` expansion), and
 * `windowsVerbatimArguments` so Node does not quote the line again. Same rules as cross-spawn.
 * Anything else (an `.exe`, a script on POSIX) is spawned as it is, without a shell.
 */

export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** True for a batch file, which Node only runs through `cmd.exe`. */
export function isBatchFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/** One argument for a `cmd.exe /s /c` line that runs a batch shim. */
export function escapeCmdArgument(arg: string): string {
  // Backslashes before a quote (or the end) are doubled, quotes escaped: the C runtime's rules.
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  // Twice: the outer cmd.exe, then the shim's own `%*`.
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** How to spawn `file argv`: through `cmd.exe` for a batch file on Windows, directly otherwise. */
export function spawnPlan(
  file: string,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env["ComSpec"] || "cmd.exe",
): SpawnPlan {
  if (!isBatchFile(file, platform)) return { file, args: [...argv], windowsVerbatimArguments: false };
  const line = [file.replace(CMD_META, "^$1"), ...argv.map(escapeCmdArgument)].join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
