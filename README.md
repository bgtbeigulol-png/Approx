# Approx

[简体中文](README_CN.md) | English

Approx is a focused coding-agent workspace for the terminal, powered by
[Pi](https://github.com/earendil-works/pi). It gives you a calm place to chat,
plan work, review file changes, and handle the Git work around a project.

This is an early beta, currently verified on Windows Terminal with PowerShell 7.

## Install

Requirements: Windows 10/11 and Node.js 22.19 or newer.

```powershell
$ErrorActionPreference = 'Stop'
npm install --global @bgtbeigulol-png/approx@beta
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
approx --help
```

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` | New line |
| `Shift+Tab` | Switch Go / Plan |
| `Ctrl+P` | Command palette |
| `Ctrl+K` | Git workbench |
| `Ctrl+O` | Settings |
| `Ctrl+G` | Quick jump |
| `Ctrl+S` | Saved conversations |
| `Ctrl+L` | Clear context |
| `Esc` | Stop or close |
| `Ctrl+C` | Exit |

Type `/help` for the complete list. Type `/git` to open the Git workbench.

## Plan Mode

Go Mode starts work immediately. Plan Mode lets Approx ask a few focused
questions and show a plan before the agent changes files. Approve with `Y` or
`Enter`; press `N` to request a revision.

## Git Workbench

Open it with `Ctrl+K` or `/git`. It shows the current branch, recent commits,
working-tree changes, staged changes, and the selected diff. From the same view
you can stage, unstage, refresh, and create a commit.

File edits made during a turn are grouped into a compact change summary in the
conversation. Expand it when you need to inspect the details.

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

