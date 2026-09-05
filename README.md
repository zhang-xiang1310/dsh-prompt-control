# dsh-prompt-control（DSH提示词）

A deployment-persistent bundle plugin for DeepSeek Harness (DSH) that adds a
**DSH提示词** page to the web Settings. From one page you can review the
system prompt DSH actually sends and append your own persistent guidance to it.

The settings page is split into two regions:

- **Top（只读 · 动态）** — the current DEFAULT DSH system prompt, assembled live
  and shown read-only. It is never overridden.
- **Bottom（可编辑）** — your appended guidance. Saving stores it, and it is
  concatenated as the **last section** of each session's rendered system
  message when a model request is assembled. Clearing the box and saving again
  removes the append.

The two displayed regions never merge: the append only joins at assembly time,
so the top region keeps showing the untouched dynamic system prompt.

Unlike an in-memory dynamic Cordis plugin (which is lost on restart), this is a
profile bundle installed under the deployment layer, so it persists and takes
effect on the next DSH start.

## Files

| Path | Role |
| --- | --- |
| `cordis.patch.yml` | Loader insert row (`id`/`name` = `dsh-prompt-control`). |
| `lib/index.js` | Host half: `/dshp/api` JSON routes + a global non-complete system-prompt suffix section. |
| `lib/client.js` | Browser half: a `settings.section` occupant "DSH提示词". |

## How the append works

The append is a **global NON-complete** system-prompt section
(`dsh-prompt:user-suffix`, order 100000) whose text is `{{dsh_prompt_suffix}}`,
resolved from a variable that returns the saved text verbatim (never re-scanned
for `{{...}}`). Because the section has no `complete` flag, the default dynamic
sections (persona, harness identity, tool descriptions, ...) are preserved and
the append lands as the final section of every assembly's rendered system
message. Tool schemas and runtime-context snapshots are separate channels and
are unaffected.

Because nothing here is `complete`, the design is compatible with every preset,
including the shipped `minimal` preset (whose persona is `complete: true`).

Saved state (only the appended text) persists to
`$DSH_HOME/dsh-prompt-control.json`.

## Install

Place this package as a real folder named `dsh-prompt-control` under the web
profile's module directory, e.g.:

```
$DSH_HOME/profiles/web/node_modules/dsh-prompt-control
```

and list `dsh-prompt-control` in that profile's `dsh.profile.bundles`. A future
`pnpm install` in the profile may prune an unregistered folder; if that happens,
re-create it before the next DSH start — a listed-but-unresolvable bundle fails
startup loudly. Restart DSH once after installing or editing the plugin.

## Usage

1. Open **设置 → DSH提示词**.
2. The top region shows the live default system prompt (read-only).
3. Type your guidance in the bottom region and click **保存** (or press
   Ctrl/Cmd+S). A status line confirms the save.
4. Clearing the box and saving again removes the appended text.

## License

MIT
