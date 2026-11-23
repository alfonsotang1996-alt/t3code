import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ThreadHudCard } from "./ThreadHudCard";
import type { ThreadHudData } from "./ThreadHudCard.logic";

vi.mock("../../hooks/useNowMinute", { spy: true });

const STORAGE_KEY = "t3code:custom:thread-hud-collapsed:v1";
const CHECKED_AT = "2026-10-30T11:59:00.000Z";
const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

function setup() {
  window.localStorage.removeItem(STORAGE_KEY);
  vi.mocked(useNowMinute).mockReturnValue("2026-10-30T12:00");
  return {
    [Symbol.dispose]: () => {
      window.localStorage.removeItem(STORAGE_KEY);
    },
  };
}

function makeProvider(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "apiKey",
      label: "API key",
    },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

const fullContextWindow: ContextWindowSnapshot = {
  usedTokens: 164_000,
  totalProcessedTokens: null,
  maxTokens: 200_000,
  remainingTokens: 36_000,
  usedPercentage: 82,
  remainingPercentage: 18,
  inputTokens: 120_000,
  cachedInputTokens: 90_000,
  outputTokens: 14_500,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: true,
  autoCompactThreshold: 170_000,
  cost: { amount: 0.42, currency: "USD" },
  updatedAt: CHECKED_AT,
};

const fullHud: ThreadHudData = {
  modelLabel: "Claude Opus 4.6",
  effortLabel: "High",
  runtimeMode: "full-access",
  isWorking: true,
  subagents: [{ status: "running" }, { status: "completed" }, { status: "pending" }],
};

const fullUsageLimits: ServerProviderUsageLimits = {
  checkedAt: CHECKED_AT,
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 28,
      windowDurationMins: 300,
      resetsAt: "2026-10-30T14:30:00.000Z",
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 12,
      windowDurationMins: 10_080,
      resetsAt: "2026-11-04T06:00:00.000Z",
    },
  ],
};

describe("ThreadHudCard", () => {
  it("renders model, runtime badge, context bar, token metrics, subagents, cost, and quota limits when expanded", async () => {
    using _fixture = setup();
    await using screen = await render(
      <ThreadHudCard
        hud={fullHud}
        usage={{
          providerInstanceId: INSTANCE_ID,
          model: "claude-opus-4-6",
          providers: [makeProvider(fullUsageLimits)],
          sources: [],
          contextWindow: fullContextWindow,
        }}
      />,
    );

    const card = screen.getByRole("region", { name: "Session status" });
    await expect.element(card).toHaveAttribute("data-collapsed", "false");
    await expect.element(card.getByText("Claude Opus 4.6")).toBeVisible();
    await expect.element(card.getByText("High")).toBeVisible();
    await expect.element(card.getByText("Full", { exact: true })).toBeVisible();
    await expect.element(card.getByText("82%")).toBeVisible();
    await expect.element(card.getByText("164.0k / 200.0k")).toBeVisible();
    await expect.element(card.getByText("120.0k", { exact: true })).toBeVisible();
    await expect.element(card.getByText("14.5k", { exact: true })).toBeVisible();
    await expect.element(card.getByText("90.0k (75%)")).toBeVisible();
    await expect.element(card.getByText("2/3")).toBeVisible();
    await expect.element(card.getByText("$0.42")).toBeVisible();
    await expect.element(card.getByText("Session")).toBeVisible();
    await expect.element(card.getByText("72%")).toBeVisible();
    await expect.element(card.getByText("2h 30m")).toBeVisible();
    await expect.element(card.getByText("Weekly")).toBeVisible();
    await expect.element(card.getByText("88%")).toBeVisible();
    await expect.element(card.getByText("4d 18h")).toBeVisible();

    const usageLink = card.getByRole("link", { name: "Session: 72% left" });
    await expect.element(usageLink).toHaveAttribute("href", "/usage");

    const statusDot = card.element().querySelector("[data-hud-status-dot]");
    expect(statusDot?.getAttribute("data-working")).toBe("true");
  });

  it("gracefully omits absent context, token, subagent, cost, and quota metrics", async () => {
    using _fixture = setup();
    const minimalHud: ThreadHudData = {
      modelLabel: "Grok 4",
      effortLabel: null,
      runtimeMode: "approval-required",
      isWorking: false,
      subagents: [],
      providerTurns: [],
    };
    const unsupportedLimits: ServerProviderUsageLimits = {
      checkedAt: CHECKED_AT,
      windows: [],
      unavailable: { reason: "unsupported" },
    };

    await using screen = await render(
      <ThreadHudCard
        hud={minimalHud}
        usage={{
          providerInstanceId: INSTANCE_ID,
          model: "grok-4",
          providers: [makeProvider(unsupportedLimits)],
          sources: [],
          contextWindow: null,
        }}
      />,
    );

    const card = screen.getByRole("region", { name: "Session status" });
    await expect.element(card.getByText("Grok 4")).toBeVisible();
    await expect.element(card.getByText("Supervised")).toBeVisible();
    await expect.element(card.getByText("Context")).not.toBeInTheDocument();
    await expect.element(card.getByText("Input")).not.toBeInTheDocument();
    await expect.element(card.getByText("Output")).not.toBeInTheDocument();
    await expect.element(card.getByText("Cache")).not.toBeInTheDocument();
    await expect.element(card.getByText("Subagents")).not.toBeInTheDocument();
    await expect.element(card.getByText("Cost")).not.toBeInTheDocument();
    expect(card.element().textContent).not.toContain("NaN");

    const statusDot = card.element().querySelector("[data-hud-status-dot]");
    expect(statusDot?.getAttribute("data-working")).toBe("false");
  });

  it("toggles between expanded and 1-line collapsed views and persists to localStorage", async () => {
    using _fixture = setup();
    await using screen = await render(
      <ThreadHudCard
        hud={fullHud}
        usage={{
          providerInstanceId: INSTANCE_ID,
          model: "claude-opus-4-6",
          providers: [makeProvider(fullUsageLimits)],
          sources: [],
          contextWindow: fullContextWindow,
        }}
      />,
    );

    const collapseBtn = screen.getByRole("button", { name: "Collapse status card" });
    await userEvent.click(collapseBtn);

    const card = page.getByRole("region", { name: "Session status" });
    await expect.element(card).toHaveAttribute("data-collapsed", "true");
    await expect.element(card.getByText("82% · 72%")).toBeVisible();
    await expect.element(card.getByText("164.0k / 200.0k")).not.toBeInTheDocument();
    await expect.element(card.getByText("Subagents")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");

    await screen.unmount();

    await using remounted = await render(
      <ThreadHudCard
        hud={fullHud}
        usage={{
          providerInstanceId: INSTANCE_ID,
          model: "claude-opus-4-6",
          providers: [makeProvider(fullUsageLimits)],
          sources: [],
          contextWindow: fullContextWindow,
        }}
      />,
    );
    const remountedCard = remounted.getByRole("region", { name: "Session status" });
    await expect.element(remountedCard).toHaveAttribute("data-collapsed", "true");
    await expect.element(remountedCard.getByText("82% · 72%")).toBeVisible();

    await userEvent.click(remountedCard.getByRole("button", { name: "Expand status card" }));
    await expect.element(remountedCard).toHaveAttribute("data-collapsed", "false");
    await expect.element(remountedCard.getByText("164.0k / 200.0k")).toBeVisible();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");
  });
});
