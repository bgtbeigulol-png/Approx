# Changelog

All notable changes to Approx are documented in this file.

## [Unreleased]

## [0.1.1] - 2026-08-18

### Added

- Added cinematic High, XHigh, and Max effort scenes: silver starlight, a black
  meteor sky with warm embers, and a layered moving ocean with reflected light.
- Added `/effort-debug` to preview the fixed seven-level effort spectrum without
  changing the active model, effort setting, or backend state.
- Added a compact live TTY panel for `approx update`, with structured progress
  and reliable cursor restoration on completion or interruption.
- Added a package-backed version source shared by the CLI, splash, and harness.

### Changed

- Effort previews now crossfade from the currently visible frame across adjacent
  or distant levels, including rapid repeated moves and panel-size changes.
- The effort track now communicates faster-to-deeper reasoning as one physical
  left-to-right color spectrum; Max uses animated multi-tone wave boundaries.
- Reduced-motion mode keeps complete static effort scenes and switches levels
  immediately without retaining animation snapshots.
- Migrated npm releases to GitHub Actions trusted publishing with short-lived
  OIDC credentials, automatic provenance, and stable `latest` tagging.

## [0.1.0] - 2026-08-09

### Added

- Added inline `@path` and `@"path with spaces"` workspace-file completion and
  highlighting, with bounded project-tree search and unchanged prompt delivery.
- Added the docked Approde sidebar for hot-swapping Pi skills and prompts,
  saving presets, restoring the last active set, and approving model requests.
- Added a four-sheet `/status` dashboard for context pressure, 90-day token
  activity, model/effort mix, and cost totals.
- Added a dedicated `/effort` picker with keyboard and pointer navigation.
- Added Git and npm update channels shared by `approx update`, `/update`, and
  Settings, including notifications, hidden notices, and optional auto-update.
- Added `approx --version` and a network-free `approx update --help` path.
- Added `/cd` directory browsing and transactional workspace switching.
- Added manual and automatic context compaction with animated progress and
  percent- or token-based thresholds.
- Added persistent Go/Plan state, editable task progress, live plan revisions,
  model-managed planning notes, and explicit approve/revise controls.
- Added structured questionnaires with keyboard navigation, choices, secrets,
  and free-form answers.
- Added Git workbench net line totals, binary labelling, bounded diff previews,
  confirmed discard, mouse targeting, and in-view commits.

### Changed

- Split the App controller, Pi backend, and Smoke suite into focused modules
  while keeping their public entry points stable.
- Reworked Settings with contextual hints, pending model/effort state, update
  controls, and direct access to the effort picker.
- Reworked transcript tool groups, file-edit groups, final `FILE CHANGES`
  summaries, queued notes, overlay ordering, and compact presentation.
- Expanded the release test pipeline to cover updater workflows, modular Pi
  startup, live Plan revision, file mentions, Git boundaries, and workspace UI.

### Fixed

- Fixed Windows Terminal IME preedit flicker with event-driven rendering and a
  native cursor anchor.
- Fixed literal NUL sentinels making `src/screen.js` appear as a binary file to
  Git while preserving the same first-frame invalidation behavior.
- Fixed stale or blank Git diff panes after async selection changes and ensured
  completed reads request a frame immediately.
- Fixed oversized and binary file previews from flooding the terminal process.
- Fixed saved-conversation replay dropping File Edit diffs and the turn-level
  `FILE CHANGES` system message.
- Fixed rewind/redo so Pi session branches and captured Write/Edit snapshots are
  restored together.
- Fixed failed session, conversation, and workspace transitions leaving a
  partially initialized backend instead of recovering the previous session.
- Fixed `/status` direction-key navigation crashing on the Activity sheet when
  no usage history has been recorded yet.
- Fixed file-reference instructions, dependency-tree traversal, and completion
  paths when the workspace is reached through a Windows junction or symlink.

## [0.1.0-beta.1] - 2026-08-07

Initial public beta.

- Added the Approx terminal interface backed by Pi.
- Added persistent conversations, model and effort controls, Plan Mode, and
  structured questions.
- Added Windows-first installation and first-run provider setup.
- Requires Node.js 22.19 or newer.

[0.1.0-beta.1]: https://github.com/bgtbeigulol-png/Approx/releases/tag/v0.1.0-beta.1
[0.1.0]: https://github.com/bgtbeigulol-png/Approx/releases/tag/v0.1.0
[0.1.1]: https://github.com/bgtbeigulol-png/Approx/releases/tag/v0.1.1
[Unreleased]: https://github.com/bgtbeigulol-png/Approx/compare/v0.1.1...HEAD
