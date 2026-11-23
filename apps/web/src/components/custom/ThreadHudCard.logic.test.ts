import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computeCacheHitPercent,
  deriveHudContextMetrics,
  deriveHudSubagentCounts,
  deriveHudTokenStats,
  formatCompactTokens,
  formatHudCost,
  readHudCollapsed,
  resolveHudQuotaRows,
  resolveHudRuntimeModeBadgeLabel,
  writeHudCollapsed,
  type ThreadHudProviderTurn,
} from "./ThreadHudCard.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");

function makeContextWindow(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    usedTokens: 120_000,
    totalProcessedTokens: null,
    maxTokens: 200_000,
    remainingTokens: 80_000,
    usedPercentage: 60,
    remainingPercentage: 40,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: true,
    autoCompactThreshold: null,
    cost: null,
    updatedAt: checkedAt,
    ...overrides,
  };
}

function makeProvider(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "customEndpoint",
      label: "Custom API endpoint",
      endpoint: "http://127.0.0.1:8317",
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("ThreadHudCard logic", () => {
  it("formats compact token counts consistently across scales", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(-50)).toBe("0");
    expect(formatCompactTokens(Number.NaN)).toBe("0");
    expect(formatCompactTokens(842)).toBe("842");
    expect(formatCompactTokens(12_400)).toBe("12.4k");
    expect(formatCompactTokens(291_200)).toBe("291.2k");
    expect(formatCompactTokens(999_950)).toBe("1.0M");
    expect(formatCompactTokens(1_000_000)).toBe("1.0M");
    expect(formatCompactTokens(1_250_000_000)).toBe("1.3B");
  });

  it("computes cache hit percentage safely and clamps bounds", () => {
    expect(computeCacheHitPercent(100_000, 65_400)).toBe(65);
    expect(computeCacheHitPercent(50_000, 0)).toBe(0);
    expect(computeCacheHitPercent(100, 150)).toBe(100);
    expect(computeCacheHitPercent(0, 100)).toBeNull();
    expect(computeCacheHitPercent(null, 100)).toBeNull();
    expect(computeCacheHitPercent(100, null)).toBeNull();
    expect(computeCacheHitPercent(Number.NaN, 10)).toBeNull();
  });

  it("formats USD and non-USD session costs and omits invalid values", () => {
    expect(formatHudCost(null)).toBeNull();
    expect(formatHudCost({ amount: Number.NaN, currency: "USD" })).toBeNull();
    expect(formatHudCost({ amount: -1, currency: "USD" })).toBeNull();
    expect(formatHudCost({ amount: 0.0042, currency: "usd" })).toBe("$0.0042");
    expect(formatHudCost({ amount: 1.4, currency: "USD" })).toBe("$1.40");
    expect(formatHudCost({ amount: 2.5, currency: "eur" })).toBe("2.50 EUR");
  });

  it("derives context window metrics, tones, and auto-compact tick", () => {
    expect(deriveHudContextMetrics(null)).toBeNull();

    const normal = deriveHudContextMetrics(
      makeContextWindow({
        usedTokens: 150_000,
        maxTokens: 200_000,
        usedPercentage: 75,
        autoCompactThreshold: 170_000,
      }),
    );
    expect(normal).toEqual({
      usedTokens: 150_000,
      maxTokens: 200_000,
      usedPercent: 75,
      tone: null,
      autoCompactThreshold: 170_000,
      tickPercent: 85,
      formattedUsed: "150.0k",
      formattedMax: "200.0k",
    });

    expect(
      deriveHudContextMetrics(
        makeContextWindow({ usedTokens: 164_000, maxTokens: 200_000, usedPercentage: 82 }),
      )?.tone,
    ).toBe("warning");
    expect(
      deriveHudContextMetrics(
        makeContextWindow({ usedTokens: 184_000, maxTokens: 200_000, usedPercentage: 92 }),
      )?.tone,
    ).toBe("error");

    const withoutMax = deriveHudContextMetrics(
      makeContextWindow({ usedTokens: 4_200, maxTokens: null, usedPercentage: null }),
    );
    expect(withoutMax).toMatchObject({
      usedTokens: 4_200,
      maxTokens: null,
      usedPercent: null,
      tickPercent: null,
      formattedUsed: "4.2k",
      formattedMax: null,
    });
  });

  it("prefers cumulative contextWindow tokens and falls back to last-turn and providerTurns", () => {
    const cumulative = deriveHudTokenStats(
      makeContextWindow({
        inputTokens: 100_000,
        outputTokens: 8_000,
        cachedInputTokens: 75_000,
        lastInputTokens: 10_000,
      }),
    );
    expect(cumulative).toEqual({
      inputTokens: 100_000,
      outputTokens: 8_000,
      cachedInputTokens: 75_000,
      cacheHitPercent: 75,
    });

    const lastTurn = deriveHudTokenStats(
      makeContextWindow({
        lastInputTokens: 20_000,
        lastOutputTokens: 2_500,
        lastCachedInputTokens: 10_000,
      }),
    );
    expect(lastTurn).toEqual({
      inputTokens: 20_000,
      outputTokens: 2_500,
      cachedInputTokens: 10_000,
      cacheHitPercent: 50,
    });

    const turnsWithTurnUsage: ThreadHudProviderTurn[] = [
      {
        providerThreadId: "pt-old",
        turnTokenUsage: { inputTokens: 99_000, outputTokens: 9_000, cachedInputTokens: 9_000 },
      },
      {
        providerThreadId: "pt-active",
        turnTokenUsage: { inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 5_000 },
      },
      {
        providerThreadId: "pt-active",
        turnTokenUsage: { inputTokens: 30_000, outputTokens: 3_000, cachedInputTokens: 15_000 },
      },
    ];
    expect(deriveHudTokenStats(makeContextWindow(), turnsWithTurnUsage, "pt-active")).toEqual({
      inputTokens: 40_000,
      outputTokens: 4_000,
      cachedInputTokens: 20_000,
      cacheHitPercent: 50,
    });

    const turnsWithLiveUsage: ThreadHudProviderTurn[] = [
      {
        providerThreadId: "pt-active",
        tokenUsage: {
          inputTokens: 5_000,
          outputTokens: 500,
          cachedInputTokens: 1_000,
          updatedAt: "2026-10-30T11:00:00.000Z",
        },
      },
      {
        providerThreadId: "pt-active",
        tokenUsage: {
          inputTokens: 12_000,
          outputTokens: 1_200,
          cachedInputTokens: 6_000,
          updatedAt: "2026-10-30T11:05:00.000Z",
        },
      },
    ];
    expect(deriveHudTokenStats(null, turnsWithLiveUsage, "pt-active")).toEqual({
      inputTokens: 12_000,
      outputTokens: 1_200,
      cachedInputTokens: 6_000,
      cacheHitPercent: 50,
    });

    expect(deriveHudTokenStats(null, [])).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheHitPercent: null,
    });
  });

  it("derives subagent active/total counts and returns null when none exist", () => {
    expect(deriveHudSubagentCounts(undefined)).toBeNull();
    expect(deriveHudSubagentCounts([])).toBeNull();
    expect(
      deriveHudSubagentCounts([
        { status: "pending" },
        { status: "running" },
        { status: "waiting" },
        { status: "completed" },
        { status: "failed" },
      ]),
    ).toEqual({ active: 3, total: 5 });
  });

  it("resolves quota rows across instance limits, CLIProxy hubs, and unsupported providers", () => {
    const unsupported: ServerProviderUsageLimits = {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    };
    expect(
      resolveHudQuotaRows({
        providerInstanceId: instanceId,
        model: null,
        providers: [{ ...makeProvider(unsupported), auth: { status: "authenticated" } }],
        sources: [],
        now,
      }),
    ).toEqual([]);

    const directLimits: ServerProviderUsageLimits = {
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 85,
          windowDurationMins: 300,
          resetsAt: "2026-10-30T13:17:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 95,
          windowDurationMins: 10_080,
          resetsAt: "2026-11-04T06:00:00.000Z",
        },
      ],
    };
    const directRows = resolveHudQuotaRows({
      providerInstanceId: instanceId,
      model: "claude-opus-4-6",
      providers: [{ ...makeProvider(directLimits), auth: { status: "authenticated" } }],
      sources: [],
      now,
    });
    expect(directRows).toHaveLength(2);
    expect(directRows[0]).toMatchObject({
      id: "five_hour",
      label: "Session",
      remainingPercent: 15,
      tone: "warning",
      resetLabel: "1h 17m",
      accounts: 1,
    });
    expect(directRows[1]).toMatchObject({
      id: "weekly",
      label: "Weekly",
      remainingPercent: 5,
      tone: "error",
      resetLabel: "4d 18h",
    });

    const hubSource: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("Hub"),
      kind: "cliproxy",
      label: "Hub",
      origin: "http://127.0.0.1:8317",
      checkedAt,
      accounts: [
        {
          id: "a.json",
          driver: claude,
          models: ["claude-opus-4-6"],
          usageLimits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 30,
                windowDurationMins: 300,
                resetsAt: "2026-10-30T14:00:00.000Z",
              },
            ],
          },
        },
      ],
    };
    const hubRows = resolveHudQuotaRows({
      providerInstanceId: instanceId,
      model: "claude-opus-4-6",
      providers: [makeProvider(unsupported)],
      sources: [hubSource],
      now,
    });
    expect(hubRows).toHaveLength(1);
    expect(hubRows[0]).toMatchObject({
      label: "Session",
      remainingPercent: 70,
      tone: null,
      resetLabel: "2h 0m",
      sourceHubs: ["Hub"],
      sourceSignedIn: false,
    });
  });

  it("persists collapsed preference in storage and resolves runtime mode badges", () => {
    const storage = createMemoryStorage();
    expect(readHudCollapsed(storage)).toBe(false);
    writeHudCollapsed(true, storage);
    expect(storage.getItem("t3code:custom:thread-hud-collapsed:v1")).toBe("true");
    expect(readHudCollapsed(storage)).toBe(true);
    writeHudCollapsed(false, storage);
    expect(readHudCollapsed(storage)).toBe(false);

    expect(resolveHudRuntimeModeBadgeLabel("approval-required")).toBe("Supervised");
    expect(resolveHudRuntimeModeBadgeLabel("auto-accept-edits")).toBe("Auto-edits");
    expect(resolveHudRuntimeModeBadgeLabel("auto")).toBe("Auto");
    expect(resolveHudRuntimeModeBadgeLabel("full-access")).toBe("Full");
  });
});
