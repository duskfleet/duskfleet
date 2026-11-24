# Harness marks

The logos of the agent CLIs Duskfleet runs, as source files for the dashboard's harness label
(`Agent/RunsOn`, design issue #482, implementation #499). The label draws the mark of the
harness before the model name.

| File | Harness | Notes |
|---|---|---|
| `claude.svg` | `claude` | monochrome, `fill="currentColor"`; used when the harness is missing on this host |
| `claude-color.svg` | `claude` | same shape, fill `#D97757`; the default mark for `claude` |
| `copilot.svg` | `copilot` | GitHub Copilot, monochrome |
| `codex.svg` | `codex` | the Codex mark (not the OpenAI one), monochrome |
| `codex-color.svg` | `codex` | app tile on white; not used by the design (unreadable at 14 px), kept for reference |
| `cursor.svg` | `cursor` | monochrome; the harness itself is issue #467 |

All are 24 x 24 `viewBox`, shapes unmodified. The design draws them at 14 px.

## Source and licence

Copied unchanged from the community icon set `@lobehub/icons-static-svg` 1.106.0
(`icons/claude.svg`, `claude-color.svg`, `githubcopilot.svg`, `codex.svg`, `codex-color.svg`,
`cursor.svg`), which its `package.json` declares MIT. They do not come from the vendors' own
press kits.

The marks are trademarks of their owners (Anthropic, GitHub, OpenAI, Anysphere). They are used
only to say which CLI an agent runs on. The vendors' brand rules (minimum size, clear space,
recolouring) have not been checked yet: that check is an open item of #499, to settle before
the label ships.

## Not shipped

This folder is not in the `files` list of `@duskfleet/web`, so nothing here is published to npm.
The implementation turns the marks it uses into inline SVG components.
