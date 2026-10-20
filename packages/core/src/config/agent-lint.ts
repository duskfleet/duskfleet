/**
 * Public-repo hygiene for agent files (CLAUDE.md "This repo is public").
 *
 * create_agent / update_agent run every spec through `assertAgentSpecClean` before the file
 * is written: an agent file may be copied into config/agents or another public repo, so it
 * must not carry home directory paths or secret-looking values. The path patterns are the
 * ones `scripts/check-public.mjs` enforces on versioned files.
 *
 * `add_dirs` legitimately point at directories of this machine: an entry inside the home
 * directory is rewritten to `~/...` (the loader expands it again), so it never needs an
 * absolute home path. An entry under another user's home is still rejected.
 */
import { homedir } from "node:os";
import path from "node:path";
import type { AgentSpec } from "./agent-files.js";

export interface AgentLintProblem {
  /** Spec field the value was found in, e.g. "system_prompt" or "add_dirs[0]". */
  field: string;
  why: string;
  /** The offending text; secrets are masked to their first characters. */
  excerpt: string;
}

const HOME_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\/Users\/[A-Za-z0-9._-]+/g, why: "macOS home path" },
  { re: /\/home\/[A-Za-z0-9._-]+/g, why: "Linux home path" },
  { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, why: "Windows home path" },
  { re: /\/Volumes\/[A-Za-z0-9._-]+/g, why: "macOS volume path" },
];

/** Placeholders docs and prompts may use (as in check-public.mjs; `/Users/<you>` never matches above). */
const PLACEHOLDER = /[/\\](?:you|me)\.*$/;

const SECRET_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, why: "Anthropic API key" },
  { re: /\bsk-[A-Za-z0-9_-]{32,}/g, why: "API key (sk-...)" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, why: "GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g, why: "GitHub token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, why: "AWS access key id" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, why: "Slack token" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, why: "Google API key" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, why: "private key" },
  {
    re: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-/+.=]{16,}/gi,
    why: "secret assignment",
  },
];

function mask(s: string): string {
  return s.length <= 8 ? s : `${s.slice(0, 8)}…`;
}

/** `<home>/x` → `~/x`; anything else unchanged. */
export function collapseHome(p: string, home: string = homedir()): string {
  if (!home || home === path.sep) return p;
  if (p === home) return "~";
  for (const sep of new Set([path.sep, "/"])) {
    if (p.startsWith(home + sep)) return `~/${p.slice(home.length + 1)}`;
  }
  return p;
}

/** Every string value of a spec with its field name (id is excluded: its pattern allows no paths). */
function stringFields(spec: AgentSpec): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(spec)) {
    if (key === "id") continue;
    if (typeof value === "string") out.push([key, value]);
    else if (Array.isArray(value))
      value.forEach((v, i) => {
        if (typeof v === "string") out.push([`${key}[${i}]`, v]);
      });
  }
  return out;
}

/** Problems that would make the agent file unfit for a public repo. Empty = clean. */
export function lintAgentSpec(spec: AgentSpec, home: string = homedir()): AgentLintProblem[] {
  const problems: AgentLintProblem[] = [];
  for (const [field, text] of stringFields(spec)) {
    for (const { re, why } of HOME_PATTERNS) {
      for (const m of text.matchAll(re)) {
        if (PLACEHOLDER.test(m[0])) continue;
        problems.push({ field, why, excerpt: m[0] });
      }
    }
    // A home directory outside the usual roots (e.g. /var/users/x); skip "/" and short roots like "/root".
    if (home.length > 5 && text.includes(home) && !problems.some((p) => p.field === field)) {
      problems.push({ field, why: "home directory path", excerpt: home });
    }
    for (const { re, why } of SECRET_PATTERNS) {
      for (const m of text.matchAll(re)) problems.push({ field, why, excerpt: mask(m[0]) });
    }
  }
  return problems;
}

/**
 * Rewrites `add_dirs` inside the home directory to `~/...`, then throws when the spec still
 * contains a home path or a secret-looking value. Returns the spec to write.
 */
export function assertAgentSpecClean(spec: AgentSpec, home: string = homedir()): AgentSpec {
  const tidy: AgentSpec = spec.add_dirs ? { ...spec, add_dirs: spec.add_dirs.map((d) => collapseHome(d, home)) } : spec;
  const problems = lintAgentSpec(tidy, home);
  if (problems.length) {
    const list = problems.map((p) => `${p.field}: ${p.why} (${p.excerpt})`).join("; ");
    throw new Error(
      `agent "${spec.id}" not written: agent files must stay fit for a public repo. ${list}. ` +
        "Use ~/... or a <placeholder> instead of a home path, and keep secrets in the environment, never in an agent file.",
    );
  }
  return tidy;
}
