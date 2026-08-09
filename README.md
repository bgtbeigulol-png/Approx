# <img src="assets/approx-icon.png" alt="" width="36" height="36"> Approx

[简体中文](README_CN.md) | English

Approx is a focused coding-agent workspace for the terminal, powered by
[Pi](https://github.com/earendil-works/pi). It gives you a calm place to chat,
plan work, review file changes, and handle the Git work around a project.

<p align="center">
  <img src="assets/approx-banner.jpg" alt="Approx CLI banner" width="800">
</p>

Approx v0.1.0 is currently verified on Windows Terminal with PowerShell 7.

## Install

Requirements: Windows 10/11 and Node.js 22.19 or newer.

```powershell
$ErrorActionPreference = 'Stop'
npm install --global @bgtbeigulol-png/approx
approx
```

Or run from source:

```powershell
$ErrorActionPreference = 'Stop'
git clone https://github.com/bgtbeigulol-png/Approx.git
Set-Location -LiteralPath .\Approx
npm ci
npm start
```

## First Run

Run `approx` in the project directory you want to work on. Approx uses Pi's
existing provider and model setup. When no model is available, Approx opens its
own setup flow so you can connect a provider without leaving the app.

Your credentials stay in Pi's user configuration. Approx does not put API keys
in project files, preferences, or conversation text.

## Everyday Use

```powershell
$ErrorActionPreference = 'Stop'
approx --continue      # continue the latest conversation
approx --no-splash     # skip the startup animation
approx --scripted      # run the offline demo
approx update          # install the newest release
approx --version       # print the installed version
approx --help
```

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` | New line |
| `Shift+Tab` | Switch Go / Plan |
| `Ctrl+P` | Command palette |
| `Ctrl+K` | Git workbench |
| `Ctrl+B` | Approde skills and prompts |
| `Ctrl+O` | Settings |
| `Ctrl+G` | Quick jump |
| `Ctrl+S` | Saved conversations |
| `Ctrl+L` | Clear context |
| `Esc` | Stop or close |
| `Ctrl+C` | Exit |

Type `/help` for the complete list. Type `/git` to open the Git workbench.

Type `@` in the composer to reference a workspace file. Approx completes nested
project paths, quotes names containing spaces, and preserves the reference as
plain prompt text so Pi can read the file only when its contents are needed.

## Updates

Run `approx update` from any terminal to check and install the newest release.
A Git checkout follows its configured upstream, requires a clean worktree, and
synchronizes npm dependencies after a fast-forward pull. An npm installation
checks the package registry and installs the exact newest published version
globally. The Settings page controls update notices and automatic updates;
`/update`, `/update install`, and `/update hide` expose the same workflow in-app.

`approx update --help` describes the standalone updater without contacting its
Git or npm channel.

## Plan Mode

Go Mode starts work immediately. Plan Mode lets Approx ask a few focused
questions and show a plan before the agent changes files. Approve with `Y` or
`Enter`; press `N` to request a revision. Plan state is stored with the session,
and edits made while the agent is working restart it from the newest snapshot.

## Approde

Open Approde with `Ctrl+B` or `/approde`. Its docked sidebar lets you enable or
disable discovered Pi skills and prompts without discarding the conversation.
You can save named presets, restore the last active set, and review model-requested
changes before they are applied.

## Status and Effort

`/status` opens four sheets for context-window pressure, recent token activity,
model and effort mix, and cost totals. Usage history is stored locally for up to
90 days. `/effort` opens a dedicated picker for the current model's supported
reasoning levels; changes made during a turn are applied to the next turn.

## Git Workbench

Open it with `Ctrl+K` or `/git`. It shows the current branch, recent commits,
working-tree changes, staged changes, net line totals, and the selected diff.
From the same view you can stage, unstage, discard with confirmation, refresh,
and create a commit. Binary files are labelled, and oversized previews are
clipped before they can flood the terminal process.

File edits made during a turn are grouped into a compact change summary in the
conversation. Expand it when you need to inspect the details.

Editing an earlier message rewinds the Pi session branch and restores captured
Write/Edit file snapshots. One-step redo rejoins the abandoned branch and
replays its file state.

## Troubleshooting

**No model is available**

Finish the setup flow shown by Approx. Existing Pi credentials and custom model
settings are reused automatically.

**`approx` is not recognized**

Restart the terminal after global installation and check the npm global path:

```powershell
$ErrorActionPreference = 'Stop'
npm prefix --global
Get-Command approx
```

**The screen looks wrong**

Use Windows Terminal with UTF-8, Unicode box characters, 24-bit color, and
mouse support.

## License

[MIT](LICENSE)
