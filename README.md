# Approx

[简体中文](README_CN.md) | English

Approx is a Windows-first coding-agent TUI powered by
[Pi](https://github.com/earendil-works/pi). It combines a focused terminal
workspace with persistent conversations, model controls, structured questions,
and a built-in Plan Mode for work that benefits from design before execution.

This is an early public beta. Windows Terminal and PowerShell 7 are the verified
environment for this release.

## Requirements

- Windows 10 or Windows 11
- Windows Terminal or another terminal with 24-bit color and mouse support
- PowerShell 7 or newer
- Node.js 22.19 or newer
- An account or API key for a model provider supported by Pi

Check the installed versions:

```powershell
$ErrorActionPreference = 'Stop'
node --version
npm --version
```

## Install

Install the public beta from npm:

```powershell
$ErrorActionPreference = 'Stop'
npm install --global @bgtbeigulol-png/approx@beta
approx
```

To install from source instead:

```powershell
$ErrorActionPreference = 'Stop'
git clone https://github.com/bgtbeigulol-png/Approx.git
Set-Location -LiteralPath .\Approx
npm ci
npm start
```

## First Run

Running `approx` starts the live Pi-backed agent. If Pi has no available model,
Approx opens first-run setup and guides you through provider configuration.
Existing Pi credentials and custom providers are reused automatically.

Credentials are owned by Pi and stored in its user configuration directory.
Approx does not copy API keys into its preferences, conversations, or project
files.

You can also open Pi's provider login helper from a source checkout:

```powershell
$ErrorActionPreference = 'Stop'
npm run auth
```

Enter `/login`, select a provider, complete authentication, then exit and run
`npm start` again.

## Usage

```powershell
$ErrorActionPreference = 'Stop'
approx                 # start a live Pi session
approx --continue      # continue the latest session for this directory
approx --no-splash     # skip the startup animation
approx --scripted      # run the offline interface demo
approx --help          # show CLI options
```

Approx uses the directory from which it is launched as the agent workspace.

### Main Keys

| Key | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` or `Ctrl+J` | Insert a line break |
| `Shift+Tab` | Switch between Go and Plan |
| `Ctrl+P` | Open the command palette |
| `Ctrl+O` | Open settings |
| `Ctrl+G` | Open quick jump |
| `Ctrl+S` | Open saved conversations |
| `Ctrl+L` | Start with a clean context |
| `Esc` | Stop the active response or close an overlay |
| `Ctrl+C` | Exit |

Type `/help` inside Approx for the complete command and key reference.

## Plan Mode

Go Mode lets the agent work immediately. Plan Mode lets it inspect the task,
collect structured answers, and present a visible plan before changing files.
Approve the plan with `Y` or `Enter`, or request a revision with `N`.

The Plan panel remains attached to its conversation and tracks execution todo
status after approval.

## Troubleshooting

**`approx` is not recognized**

Restart the terminal after global installation and confirm npm's global binary
directory is on `PATH`:

```powershell
$ErrorActionPreference = 'Stop'
npm prefix --global
Get-Command approx
```

**No model is available**

Complete the first-run setup or run the Pi login helper from a source checkout.
For an existing Pi installation, verify that Pi itself lists a model before
starting Approx.

**The terminal reports that stdout is not a TTY**

Run Approx directly in Windows Terminal instead of redirecting its output to a
file or pipeline.

**Rendering looks incorrect**

Use an up-to-date terminal with UTF-8, Unicode box drawing, 24-bit color, and
mouse reporting enabled. Windows Terminal is the supported baseline.

## Privacy

Model requests, authentication, sessions, tools, and provider configuration are
handled by Pi. Review the terms and data policies of the provider you select.
Do not commit `.pi`, `.claude`, `.env`, log, or credential files to a project.

## License

[MIT](LICENSE)
