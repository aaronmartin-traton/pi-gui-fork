# pi-gui verification map

Choose proof by product importance and affected behavior. Core conversation coverage comes first; opening peripheral screens is not sufficient proof of this app.

## Baseline preconditions

Build the current checkout. Use a visible, focused Electron process with test mode unset and an isolated profile/workspace. Real-provider proof requires an explicit auth source, provider, and model. Missing authentication is a blocker. Run the doctor before driving and serialize foreground input/build ownership.

## Driving conventions

The parent skill documents the default `scripts/prove.sh` conversation command, `--maintenance` for the remaining mapped surfaces, and the separate `--smoke` UI check. Drive mutations through buttons, keyboard, and composer input; use DOM/state reads only for observation. No session-creation IPC, synthetic assistant events, or seeded transcripts in conversation or maintenance proof. The scratch workspace and initial model configuration are setup fixtures, not UI proof of those setup paths.

## Proof and skip reporting

Record exact feature/entry point, command, result and evidence directory. `completed` in progress/result JSON means a checkpoint was reached; inspect `assertionFailures` as well. Soft draft assertions retain failures while allowing later paths to run; any such failure makes the whole test fail. A map is coverage intent, not a list of passed tests. Each run's result/progress files state the checkpoints actually exercised. A failed or skipped core flow cannot be replaced by a passing settings check. Distinguish navigation to a surface from functional proof on it. Preserve evidence through cleanup.

## Features, in priority order

| Priority   | Feature                                         | Executable coverage                                                                                          |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Core       | [Conversations](conversations.md)               | Default real-provider proof: send, streaming, completion, tool, stop                                         |
| Core       | [Thread continuity](thread-continuity.md)       | Default proof: switch while running, isolation, background completion, drafts, restart, archive/restore      |
| Next       | [Queued follow-ups and steering](follow-ups.md) | `--maintenance`: visible Enter-queue and modified-Enter steer with real auth                                 |
| Next       | [Folders and threads](navigation.md)            | `--maintenance`: New thread until Show more Today, and pin/unpin while a run is going                        |
| Next       | [Archive and restore](archive.md)               | Default proof on a real conversation; core spec adds hover/group checks                                      |
| Supporting | [Settings](settings.md)                         | `--smoke`: visible navigation and preference restart                                                         |
| Supporting | [Skills](skills.md)                             | `--smoke` covers opening; `--maintenance` covers Try and aliases                                             |
| Supporting | [Scheduled tasks](scheduled-tasks.md)           | Core Electron specs for list/create/fire/tool; not in default conversation proof                             |
| Supporting | [Worktrees](worktrees.md)                       | `--maintenance` switches to Workspace grouping, creates a permanent worktree, and checks `git worktree list` |

Packaged-app launch, native dialogs/clipboard, model/account onboarding, attachments, file/diff/terminal interaction, and broader extension behavior require separate mapped journeys as those features are changed. Do not claim full-app coverage from this initial map.

These user-facing surfaces have no feature file and no `prove.sh` checkpoint yet; a lane passing says nothing about them:

- Review panel (Cmd/Ctrl+R: diff beside a file tree, scope menu, Staged/Unstaged, quiet refresh on window focus), `apps/desktop/src/features/workbench/`; core `review-layout`, `review-scopes`, `review-auto-refresh` specs.
- Side panel tabs on Control+1–9 (macOS) or Alt+1–9 elsewhere, `apps/desktop/src/features/workbench/side-panel-tab-hints.ts`; core `side-panel-tab-shortcuts.spec.ts`.
- Context ring beside the model picker, `apps/desktop/src/features/conversation/context-meter.tsx`.
- Changes card after a turn that edited files, `apps/desktop/src/features/conversation/turn-changes-card.tsx`; core `turn-changes-card.spec.ts`.
- Add to Chat: select transcript text, annotate, and send the notes with the next message, `apps/desktop/src/features/conversation/annotations/`; core `transcript-annotations.spec.ts`.
- Extension notify toast above the composer and extension messages in the transcript, `apps/desktop/src/features/extensions/extension-notices.tsx` and `apps/desktop/src/features/conversation/timeline-item.tsx`; core `extension-notices.spec.ts`, `extension-custom-messages.spec.ts`.
- Theme presets built from seed colours, Settings > Appearance; core `settings-appearance.spec.ts`.
- Browse branches (session tree), `apps/desktop/src/features/conversation/tree-modal.tsx`; core `tree-command.spec.ts`.

