import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2Subagent,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type TurnTokenUsage,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  type LimitPace,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import {
  nextPoolReset,
  poolSources,
  resolveThreadDetailsLimits,
} from "../chat/ThreadDetailsUsage.logic";

const THREAD_HUD_COLLAPSED_STORAGE_KEY = "t3code:custom:thread-hud-collapsed:v1";

export type HudTone = "error" | "warning" | null;

export interface ThreadHudProviderTurn {
  readonly providerThreadId?: string | null | undefined;
  readonly tokenUsage?:
    | Pick<
        OrchestrationV2ProviderTurnTokenUsage,
        "inputTokens" | "cachedInputTokens" | "outputTokens" | "updatedAt"
      >
    | undefined;
  readonly turnTokenUsage?:
    | Pick<TurnTokenUsage, "inputTokens" | "cachedInputTokens" | "outputTokens">
    | undefined;
}

export interface ThreadHudSubagent {
  readonly status: OrchestrationV2Subagent["status"];
}

export interface ThreadHudData {
  readonly modelLabel: string | null;
  readonly effortLabel: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly isWorking: boolean;
  readonly activeProviderThreadId?: string | null | undefined;
  readonly providerTurns?: ReadonlyArray<ThreadHudProviderTurn> | undefined;
  readonly subagents?: ReadonlyArray<ThreadHudSubagent> | undefined;
}

export interface HudContextMetrics {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercent: number | null;
  readonly tone: HudTone;
  readonly autoCompactThreshold: number | null;
  readonly tickPercent: number | null;
  readonly formattedUsed: string;
  readonly formattedMax: string | null;
}

export interface HudTokenStats {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheHitPercent: number | null;
}

export interface HudSubagentCounts {
  readonly active: number;
  readonly total: number;
}

export interface HudQuotaRow {
  readonly id: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly tone: HudTone;
  readonly tick: number | null;
  readonly resetsAt: string | null;
  readonly resetLabel: string | null;
  readonly paceLabel: string | null;
  readonly timeLeftPercent: number | null;
  readonly accounts: number;
  readonly restoresPercent: number | null;
  readonly sourceHubs: readonly string[];
  readonly sourceSignedIn: boolean;
}

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

const RUNTIME_MODE_BADGE_LABEL: Record<RuntimeMode, string> = {
  "approval-required": msg("Supervised", {
    $context: "permission mode, agent asks before acting",
  }),
  "auto-accept-edits": msg("Auto-edits", {
    $context: "short permission mode badge, auto-approves edits",
  }),
  auto: msg("Auto", { $context: "permission mode, provider approves routine actions" }),
  "full-access": msg("Full", {
    $context: "short permission mode badge, allows all actions without prompts",
  }),
};

function defaultStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readHudCollapsed(storage: Storage | null | undefined = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(THREAD_HUD_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeHudCollapsed(
  collapsed: boolean,
  storage: Storage | null | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(THREAD_HUD_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Ignore quota or privacy-mode storage failures.
  }
}

function asNonNegativeFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatCompactTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  const safe = Math.max(0, Math.round(count));
  if (safe < 1_000) return `${safe}`;
  if (safe < 999_950) return `${(safe / 1_000).toFixed(1)}k`;
  if (safe < 999_950_000) return `${(safe / 1_000_000).toFixed(1)}M`;
  return `${(safe / 1_000_000_000).toFixed(1)}B`;
}

export function computeCacheHitPercent(
  inputTokens: number | null,
  cachedInputTokens: number | null,
): number | null {
  const input = asNonNegativeFinite(inputTokens);
  const cached = asNonNegativeFinite(cachedInputTokens);
  if (input === null || cached === null || input <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, (cached / input) * 100)));
}

export function formatHudCost(cost: ContextWindowSnapshot["cost"]): string | null {
  if (!cost || !Number.isFinite(cost.amount) || cost.amount < 0) return null;
  const currency = cost.currency.trim().toUpperCase();
  if (currency === "USD") {
    return cost.amount > 0 && cost.amount < 0.01
      ? `$${cost.amount.toFixed(4)}`
      : `$${cost.amount.toFixed(2)}`;
  }
  return currency ? `${cost.amount.toFixed(2)} ${currency}` : cost.amount.toFixed(2);
}

export function deriveHudContextMetrics(
  contextWindow: ContextWindowSnapshot | null,
): HudContextMetrics | null {
  if (contextWindow === null || !Number.isFinite(contextWindow.usedTokens)) return null;
  const usedTokens = Math.max(0, contextWindow.usedTokens);
  const rawMax = asNonNegativeFinite(contextWindow.maxTokens);
  const maxTokens = rawMax !== null && rawMax > 0 ? rawMax : null;
  const rawPercent =
    maxTokens !== null
      ? contextWindow.usedPercentage !== null && Number.isFinite(contextWindow.usedPercentage)
        ? contextWindow.usedPercentage
        : (usedTokens / maxTokens) * 100
      : null;
  const usedPercent =
    rawPercent !== null ? Math.round(Math.max(0, Math.min(100, rawPercent))) : null;
  const tone: HudTone =
    usedPercent === null
      ? null
      : usedPercent >= 90
        ? "error"
        : usedPercent >= 80
          ? "warning"
          : null;
  const rawThreshold = asNonNegativeFinite(contextWindow.autoCompactThreshold);
  const autoCompactThreshold = rawThreshold !== null && rawThreshold > 0 ? rawThreshold : null;
  const tickPercent =
    maxTokens !== null && autoCompactThreshold !== null && autoCompactThreshold < maxTokens
      ? (autoCompactThreshold / maxTokens) * 100
      : null;
  return {
    usedTokens,
    maxTokens,
    usedPercent,
    tone,
    autoCompactThreshold,
    tickPercent,
    formattedUsed: formatCompactTokens(usedTokens),
    formattedMax: maxTokens !== null ? formatCompactTokens(maxTokens) : null,
  };
}

function sumTurnField(
  turns: ReadonlyArray<ThreadHudProviderTurn>,
  pick: (turn: ThreadHudProviderTurn) => number | undefined,
): number | null {
  let total = 0;
  let found = false;
  for (const turn of turns) {
    const value = asNonNegativeFinite(pick(turn));
    if (value !== null) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

export function deriveHudTokenStats(
  contextWindow: ContextWindowSnapshot | null,
  providerTurns?: ReadonlyArray<ThreadHudProviderTurn>,
  activeProviderThreadId?: string | null,
): HudTokenStats {
  const cumulativeInput = asNonNegativeFinite(contextWindow?.inputTokens);
  const cumulativeOutput = asNonNegativeFinite(contextWindow?.outputTokens);
  const cumulativeCached = asNonNegativeFinite(contextWindow?.cachedInputTokens);
  if (cumulativeInput !== null || cumulativeOutput !== null || cumulativeCached !== null) {
    return {
      inputTokens: cumulativeInput,
      outputTokens: cumulativeOutput,
      cachedInputTokens: cumulativeCached,
      cacheHitPercent: computeCacheHitPercent(cumulativeInput, cumulativeCached),
    };
  }

  const lastInput = asNonNegativeFinite(contextWindow?.lastInputTokens);
  const lastOutput = asNonNegativeFinite(contextWindow?.lastOutputTokens);
  const lastCached = asNonNegativeFinite(contextWindow?.lastCachedInputTokens);
  if (lastInput !== null || lastOutput !== null || lastCached !== null) {
    return {
      inputTokens: lastInput,
      outputTokens: lastOutput,
      cachedInputTokens: lastCached,
      cacheHitPercent: computeCacheHitPercent(lastInput, lastCached),
    };
  }

  const matchingTurns = (providerTurns ?? []).filter(
    (turn) =>
      activeProviderThreadId == null ||
      turn.providerThreadId == null ||
      turn.providerThreadId === activeProviderThreadId,
  );

  const summedInput = sumTurnField(matchingTurns, (turn) => turn.turnTokenUsage?.inputTokens);
  const summedOutput = sumTurnField(matchingTurns, (turn) => turn.turnTokenUsage?.outputTokens);
  const summedCached = sumTurnField(
    matchingTurns,
    (turn) => turn.turnTokenUsage?.cachedInputTokens,
  );
  if (summedInput !== null || summedOutput !== null || summedCached !== null) {
    return {
      inputTokens: summedInput,
      outputTokens: summedOutput,
      cachedInputTokens: summedCached,
      cacheHitPercent: computeCacheHitPercent(summedInput, summedCached),
    };
  }

  let latestTurnUsage: ThreadHudProviderTurn["tokenUsage"] | null = null;
  for (const turn of matchingTurns) {
    const usage = turn.tokenUsage;
    if (!usage) continue;
    if (
      latestTurnUsage === null ||
      Date.parse(usage.updatedAt) >= Date.parse(latestTurnUsage.updatedAt)
    ) {
      latestTurnUsage = usage;
    }
  }
  const turnInput = asNonNegativeFinite(latestTurnUsage?.inputTokens);
  const turnOutput = asNonNegativeFinite(latestTurnUsage?.outputTokens);
  const turnCached = asNonNegativeFinite(latestTurnUsage?.cachedInputTokens);
  return {
    inputTokens: turnInput,
    outputTokens: turnOutput,
    cachedInputTokens: turnCached,
    cacheHitPercent: computeCacheHitPercent(turnInput, turnCached),
  };
}

export function deriveHudSubagentCounts(
  subagents: ReadonlyArray<ThreadHudSubagent> | null | undefined,
): HudSubagentCounts | null {
  if (!subagents || subagents.length === 0) return null;
  let active = 0;
  for (const subagent of subagents) {
    if (isOrchestrationV2WorkActive(subagent.status)) active += 1;
  }
  return { active, total: subagents.length };
}

function quotaTone(left: number): HudTone {
  if (left <= 10) return "error";
  if (left <= 20) return "warning";
  return null;
}

export function resolveHudQuotaRows(
  input: {
    readonly providerInstanceId: ProviderInstanceId | null;
    readonly model: string | null;
    readonly providers: readonly ServerProvider[];
    readonly sources: UsageLimitSourceSnapshots;
    readonly now: number;
  },
  resolve: MessageResolver = m,
): readonly HudQuotaRow[] {
  const resolved = resolveThreadDetailsLimits(
    input.providerInstanceId,
    input.model,
    input.providers,
    input.sources,
    input.now,
  );
  if (!resolved) return [];

  if (resolved.kind === "pool") {
    return resolved.windows.map((window) => {
      const left = window.remainingPercent;
      const next = nextPoolReset(window, input.now);
      const resetsAt = next?.member.window.resetsAt ?? null;
      const resetLabel =
        next && resetsAt && next.at > input.now
          ? formatDuration(next.at - input.now, resolve)
          : null;
      const from = poolSources(window);
      return {
        id: window.id,
        label: window.label,
        remainingPercent: left,
        tone: quotaTone(left),
        tick: null,
        resetsAt,
        resetLabel,
        paceLabel: window.pace ? resolve(PACE_LABEL[window.pace]) : null,
        timeLeftPercent: null,
        accounts: window.members.length,
        restoresPercent: next?.restoresPercent ?? null,
        sourceHubs: from.hubs,
        sourceSignedIn: from.signedIn,
      };
    });
  }

  if (limitsNotice(resolved.limits, resolve) !== null) return [];

  return resolved.limits.windows.map((window) => {
    const left = remainingPercent(window);
    const pace = paceOf(window, input.now);
    const timeLeftPercent = paceRemainingPercent(window, input.now);
    const resetsAt = window.resetsAt ?? null;
    const resetsAtMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    const resetLabel =
      resetsAt && Number.isFinite(resetsAtMs) && resetsAtMs > input.now
        ? formatDuration(resetsAtMs - input.now, resolve)
        : null;
    return {
      id: window.id,
      label: window.label,
      remainingPercent: left,
      tone: quotaTone(left),
      tick: timeLeftPercent,
      resetsAt,
      resetLabel,
      paceLabel: pace ? resolve(PACE_LABEL[pace]) : null,
      timeLeftPercent,
      accounts: 1,
      restoresPercent: null,
      sourceHubs: [],
      sourceSignedIn: false,
    };
  });
}

export function resolveHudRuntimeModeBadgeLabel(
  mode: RuntimeMode,
  resolve: MessageResolver = m,
): string {
  return resolve(RUNTIME_MODE_BADGE_LABEL[mode]);
}
