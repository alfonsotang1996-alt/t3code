# Fork Workflow (`alfonsotang1996-alt/t3code`)

This repository is a personal fork of `pingdotgg/t3code` maintained with a **Git Fork + Upstream Sync** workflow so custom features stay intact while continuously pulling upstream updates.

## Remotes & Branches

- `origin`: `https://github.com/alfonsotang1996-alt/t3code.git` (personal fork)
- `upstream`: `https://github.com/pingdotgg/t3code.git` (official repo; push is disabled via `DISABLE`)
- `main`: Clean mirror of `upstream/main`. **Never commit custom changes to `main`.**
- `custom`: Long-lived integration branch holding all custom features on top of `main`.
- `feat/<name>`: Short-lived feature branches branched from `custom` and merged back into `custom`.

## Upstream Sync SOP

```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
git checkout custom
git merge main
git push origin custom
```

## Custom Feature Conventions (Minimize Merge Conflicts)

- Keep custom features modular, pure-frontend where possible, and easy to remove once upstream ships native equivalents:
  - Web UI components & local state: `apps/web/src/components/custom/` (prefer client-side `localStorage` persistence; avoid touching `packages/contracts`, `apps/server`, or SQLite migrations unless strictly required).
- Keep edits to upstream files (`AGENTS.md`, `Sidebar.tsx`, `ChatView.tsx`, `MarkdownCodeBlock.tsx`, etc.) to minimal integration hooks.
- Never open feature PRs against `pingdotgg/t3code` unless explicitly asked; push fork work to `origin` (`custom` or `feat/*`).
- Local development and testing must use isolated dev data (`~/.t3/dev` or worktree `.t3/userdata`), never the live `~/.t3/userdata` used by the running desktop app.
- Build local macOS desktop app via `vp run dist:desktop:dmg:arm64` (output under `release/`).
