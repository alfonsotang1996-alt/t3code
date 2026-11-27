---
name: sync-fork
description: Sync this personal fork (`alfonsotang1996-alt/t3code`) with upstream (`pingdotgg/t3code`), verify custom features, push `origin/custom`, and build the macOS ARM64 DMG. Use when the user asks to sync upstream updates or rebuild their fork desktop app.
---

# Sync Fork & Build Desktop DMG

Read [FORK.md](../../../FORK.md) and [AGENTS.md](../../../AGENTS.md) before running git commands.

## Rules

- `origin` is `alfonsotang1996-alt/t3code`; `upstream` is `pingdotgg/t3code` (push disabled).
- Never commit custom changes to `main`. Never push to `upstream`. Never open PRs unless explicitly asked.
- Never touch live `~/.t3/userdata`.
- In-app auto-updates are intentionally blocked in this fork so official releases never overwrite `/Applications/T3 Code.app`.

## Workflow

1. **Record pre-sync `main` SHA & sync `main` from `upstream`:**

   ```bash
   OLD_MAIN=$(git rev-parse main)
   git fetch upstream
   git checkout main
   git merge --ff-only upstream/main
   git push origin main
   ```

2. **Review upstream changes & run a mandatory Security / Outbound Audit:**
   Before merging or building, inspect `git log --oneline "$OLD_MAIN..main"` and audit `git diff "$OLD_MAIN..main"` (use a `research` subagent for large releases) for:
   - **Changelog summary**: key user-facing changes, breaking DB migrations, or dependency bumps.
   - **Telemetry / analytics / crash reporting**: any new `ingest.t3.codes`, PostHog, Axiom, OTLP, Sentry, or default-on tracking paths. Verify `apps/server/src/telemetry/AnalyticsService.ts` still defaults to `enabledByDefault = false`.
   - **Updater / overwrite risk**: any changes to `apps/desktop/src/updates/` or `apps/server/src/cloud/selfUpdate.ts` that could bypass our notify-only fork guard in `DesktopUpdates.ts`.
   - **Outbound network / proxy / auth**: any new hardcoded external URLs, relay/tunnel/Clerk auto-connect paths, auth scope expansions, or credential/env-var handling changes.
   - **Red-flag gate**: If the audit finds any new default-on tracking, silent auto-update bypass, or suspicious outbound data leak, report it clearly to the user and fix/disable it before building the DMG.

3. **Merge `main` into `custom`:**

   ```bash
   git checkout custom
   git merge main --no-edit
   ```
   - Resolve any conflicts (typically `apps/web/src/components/Sidebar.tsx` and `apps/web/src/i18n/translations/*.json`).
   - For `apps/web/src/i18n/translations/*.json`: take `--theirs`, run `cd apps/web && vp run i18n:generate`, restore/verify custom Chinese translations in `zh.json`, run `vp fmt`, and verify `vp run i18n:check`.
   - Keep custom fork defaults intact:
     - `apps/server/src/telemetry/AnalyticsService.ts` (`enabledByDefault = false`)
     - `apps/desktop/src/updates/DesktopUpdates.ts` (notify-only updates; block in-app download/install)

4. **Install updated deps & verify:**

   ```bash
   vp i
   vp test run apps/web/src/components/custom/ apps/server/src/telemetry/AnalyticsService.test.ts apps/desktop/src/updates/DesktopUpdates.test.ts
   git add -A && git commit --no-edit
   vp run check:changed
   git push origin custom
   ```

   _(Always commit the merge before running `vp run check:changed` so it diffs against the new `origin/main`.)_

5. **Build macOS ARM64 DMG:**

   ```bash
   vp run dist:desktop:dmg:arm64
   ```
   - If `cargo` complains that `sysinfo` needs a newer `rustc`, run `rustup update stable` and re-run `vp run dist:desktop:dmg:arm64`.
   - Output artifact: `release/T3-Code-<version>-arm64.dmg`.

6. **Hand back summary & install steps to the user:**
   - Share the concise **upstream changelog + security audit verdict** (what changed, whether any new telemetry/outbound/auth risks were found or blocked).
   - Backup DB: `cp ~/.t3/userdata/statev2.sqlite ~/.t3/userdata/statev2.sqlite.bak`
   - Quit T3 Code (`Cmd+Q`)
   - Open `release/T3-Code-<version>-arm64.dmg`, drag `T3 Code.app` to `/Applications` (Replace), and relaunch.
