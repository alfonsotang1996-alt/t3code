import { Link } from "@tanstack/react-router";
import { T, useGT, useLocale, useMessages } from "gt-react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { formatContextWindowCompactionMessage } from "../chat/compaction.logic";
import { resolveRuntimeModeOption } from "../chat/runtimeModeConfig";
import type { ThreadDetailsUsageInput } from "../chat/ThreadDetailsUsage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  type HudQuotaRow,
  type HudTone,
  type ThreadHudData,
} from "./ThreadHudCard.logic";

function toneBarClass(tone: HudTone, muted = false): string {
  if (tone === "error") return "bg-error";
  if (tone === "warning") return "bg-warning";
  return muted ? "bg-muted-foreground" : "bg-foreground/80";
}

function toneTextClass(tone: HudTone): string {
  if (tone === "error") return "text-error-foreground";
  if (tone === "warning") return "text-warning-foreground";
  return "text-foreground/80";
}

function MetricCell({
  label,
  value,
  highlight = false,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly highlight?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <span className="truncate text-2xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "shrink-0 font-medium tabular-nums text-2xs",
          highlight ? "text-primary" : "text-foreground/85",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function QuotaRow({ row, now }: { readonly row: HudQuotaRow; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const sourceLabels = [
    ...row.sourceHubs,
    ...(row.sourceSignedIn ? [gt("Signed-in accounts")] : []),
  ];
  const resetsAtMs = row.resetsAt ? Date.parse(row.resetsAt) : Number.NaN;
  const upcomingResetTime =
    row.resetsAt && Number.isFinite(resetsAtMs) && resetsAtMs > now
      ? formatUpcomingTimestamp(row.resetsAt, timestampFormat, now, undefined, m)
      : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/usage"
            aria-label={gt("{label}: {left}% left", {
              label: row.label,
              left: row.remainingPercent,
            })}
            className="group flex cursor-pointer flex-col gap-1 rounded-lg px-2 py-1 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-black/[0.06] data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:active:bg-white/[0.12] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-2xs text-muted-foreground group-hover:text-foreground">
            {row.label}
          </span>
          <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
            {row.resetLabel ? (
              <span className="text-3xs text-muted-foreground">{row.resetLabel}</span>
            ) : null}
            <span className={cn("text-2xs font-medium", toneTextClass(row.tone))}>
              {`${row.remainingPercent}%`}
            </span>
          </span>
        </div>
        <span className="relative h-[3px] w-full rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
          {row.remainingPercent > 0 ? (
            <span
              className={cn("absolute inset-y-0 left-0 rounded-full", toneBarClass(row.tone))}
              style={{ width: `max(${row.remainingPercent}%, 6px)` }}
            />
          ) : null}
          {row.tick !== null ? (
            <span
              aria-hidden
              className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
              style={{ left: `clamp(0.5px, ${row.tick}%, calc(100% - 0.5px))` }}
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {row.accounts > 1
              ? gt("{label}: {left}% left across {accounts} accounts", {
                  label: row.label,
                  left: row.remainingPercent,
                  accounts: row.accounts,
                })
              : gt("{label}: {left}% left", {
                  label: row.label,
                  left: row.remainingPercent,
                })}
          </span>
          {row.paceLabel ? (
            <span className="text-muted-foreground">
              {row.timeLeftPercent !== null
                ? `${row.paceLabel} · ${gt("{timeLeft}% of the window left", {
                    timeLeft: row.timeLeftPercent,
                  })}`
                : row.paceLabel}
            </span>
          ) : null}
          {row.resetLabel && upcomingResetTime ? (
            <span className="text-muted-foreground">
              {row.accounts > 1 && row.restoresPercent !== null
                ? gt("+{percent}% in {duration} · {time}", {
                    percent: row.restoresPercent,
                    duration: row.resetLabel,
                    time: upcomingResetTime,
                  })
                : gt("Resets in {duration} · {time}", {
                    duration: row.resetLabel,
                    time: upcomingResetTime,
                  })}
            </span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="text-muted-foreground">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
          <span className="text-muted-foreground">{gt("Open usage")}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function ThreadHudCard({
  hud,
  usage,
}: {
  readonly hud: ThreadHudData;
  readonly usage: ThreadDetailsUsageInput;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const [collapsed, setCollapsed] = useState<boolean>(() => readHudCollapsed());

  const context = deriveHudContextMetrics(usage.contextWindow);
  const tokenStats = deriveHudTokenStats(
    usage.contextWindow,
    hud.providerTurns,
    hud.activeProviderThreadId,
  );
  const cacheHitPercent = computeCacheHitPercent(
    tokenStats.inputTokens,
    tokenStats.cachedInputTokens,
  );
  const subagents = deriveHudSubagentCounts(hud.subagents);
  const costLabel = formatHudCost(usage.contextWindow?.cost ?? null);
  const quotaRows = resolveHudQuotaRows(
    {
      providerInstanceId: usage.providerInstanceId,
      model: usage.model,
      providers: usage.providers,
      sources: usage.sources,
      now,
    },
    m,
  );

  const runtimeModeOption = resolveRuntimeModeOption(hud.runtimeMode, m);
  const runtimeModeBadgeLabel = resolveHudRuntimeModeBadgeLabel(hud.runtimeMode, m);
  const hasTokenOrWorkMetrics =
    tokenStats.inputTokens !== null ||
    tokenStats.outputTokens !== null ||
    tokenStats.cachedInputTokens !== null ||
    subagents !== null ||
    costLabel !== null;

  const firstQuota = quotaRows[0] ?? null;
  const collapsedSummaryParts = [
    ...(context?.usedPercent !== null && context?.usedPercent !== undefined
      ? [`${context.usedPercent}%`]
      : []),
    ...(firstQuota ? [`${firstQuota.remainingPercent}%`] : []),
  ];

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeHudCollapsed(next);
  };

  const statusText = hud.isWorking
    ? gt("Working", { $context: "agent session status" })
    : gt("Idle", { $context: "agent session status" });

  return (
    <section
      aria-label={gt("Session status")}
      data-thread-hud-card
      data-collapsed={collapsed ? "true" : "false"}
      className="dropdown-glass isolate contain-paint overflow-hidden rounded-2xl text-xs"
    >
      <div className="flex min-w-0 items-center gap-1.5 px-3 py-2">
        <span
          aria-hidden
          data-hud-status-dot
          data-working={hud.isWorking ? "true" : "false"}
          className={cn(
            "size-2 shrink-0 rounded-full",
            hud.isWorking
              ? "bg-primary motion-safe:animate-status-pulse"
              : "bg-muted-foreground/45",
          )}
        />
        <span className="sr-only">{statusText}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {hud.modelLabel || gt("No model")}
        </span>
        {!collapsed && hud.effortLabel ? (
          <span className="shrink-0 text-2xs text-muted-foreground">{hud.effortLabel}</span>
        ) : null}
        {collapsed ? (
          <>
            {collapsedSummaryParts.length > 0 ? (
              <span className="shrink-0 text-2xs font-medium tabular-nums text-muted-foreground">
                {collapsedSummaryParts.join(" · ")}
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-micro"
              aria-expanded={false}
              aria-label={gt("Expand status card")}
              onClick={toggleCollapsed}
            >
              <ChevronDownIcon aria-hidden />
            </Button>
          </>
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="secondary" size="sm">
                    {runtimeModeBadgeLabel}
                  </Badge>
                }
              />
              <TooltipPopup side="left" sideOffset={16}>
                <div className="flex flex-col gap-0.5">
                  <span className="text-foreground">{runtimeModeOption.label}</span>
                  <span className="text-muted-foreground">{runtimeModeOption.description}</span>
                </div>
              </TooltipPopup>
            </Tooltip>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-micro"
              aria-expanded={true}
              aria-label={gt("Collapse status card")}
              onClick={toggleCollapsed}
            >
              <ChevronUpIcon aria-hidden />
            </Button>
          </>
        )}
      </div>

      {!collapsed && context ? (
        <div className="border-t border-border/65 px-2 py-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  tabIndex={0}
                  aria-label={
                    context.usedPercent !== null
                      ? gt("{label}: {value}", {
                          label: gt("Context", { $context: "context window row label" }),
                          value: gt("{used}% used", { used: context.usedPercent }),
                        })
                      : gt("{label}: {value}", {
                          label: gt("Context", { $context: "context window row label" }),
                          value: gt("{usedTokens} tokens used", {
                            usedTokens: context.formattedUsed,
                          }),
                        })
                  }
                  className="flex cursor-default flex-col gap-1 rounded-lg px-2 py-1 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
                />
              }
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-2xs text-muted-foreground">
                  <T context="context window row label">Context</T>
                </span>
                {context.usedPercent !== null ? (
                  <span
                    className={cn("text-2xs font-medium tabular-nums", toneTextClass(context.tone))}
                  >
                    {`${context.usedPercent}%`}
                  </span>
                ) : null}
              </div>
              {context.usedPercent !== null ? (
                <span className="relative h-[4px] w-full rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
                  {context.usedPercent > 0 ? (
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-full",
                        toneBarClass(context.tone, true),
                      )}
                      style={{ width: `max(${context.usedPercent}%, 6px)` }}
                    />
                  ) : null}
                  {context.tickPercent !== null ? (
                    <span
                      aria-hidden
                      className="absolute -top-[2.5px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
                      style={{ left: `clamp(0.5px, ${context.tickPercent}%, calc(100% - 0.5px))` }}
                    />
                  ) : null}
                </span>
              ) : null}
              <div className="text-end text-2xs font-medium tabular-nums text-muted-foreground">
                {context.formattedMax !== null
                  ? `${context.formattedUsed} / ${context.formattedMax}`
                  : context.formattedUsed}
              </div>
            </TooltipTrigger>
            <TooltipPopup side="left" sideOffset={16}>
              <div className="flex flex-col gap-0.5">
                <span className="text-foreground">
                  {context.usedPercent !== null
                    ? gt("Context: {used}% used", { used: context.usedPercent })
                    : gt("Context: {usedTokens} tokens used", {
                        usedTokens: context.formattedUsed,
                      })}
                </span>
                {context.maxTokens !== null ? (
                  <span className="text-muted-foreground">
                    {gt("{used} of {max} tokens", {
                      used: context.usedTokens.toLocaleString(locale),
                      max: context.maxTokens.toLocaleString(locale),
                    })}
                  </span>
                ) : null}
                {context.autoCompactThreshold !== null ? (
                  <span className="text-muted-foreground">
                    {formatContextWindowCompactionMessage(context.autoCompactThreshold, m, locale)}
                  </span>
                ) : null}
              </div>
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}

      {!collapsed && hasTokenOrWorkMetrics ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border/65 px-3 py-2">
          {tokenStats.inputTokens !== null ? (
            <MetricCell
              label={<T context="token usage metric label">Input</T>}
              value={formatCompactTokens(tokenStats.inputTokens)}
            />
          ) : null}
          {tokenStats.outputTokens !== null ? (
            <MetricCell
              label={<T context="token usage metric label">Output</T>}
              value={formatCompactTokens(tokenStats.outputTokens)}
            />
          ) : null}
          {tokenStats.cachedInputTokens !== null ? (
            <MetricCell
              label={<T context="prompt cache hit tokens metric label">Cache</T>}
              value={
                cacheHitPercent !== null
                  ? `${formatCompactTokens(tokenStats.cachedInputTokens)} (${cacheHitPercent}%)`
                  : formatCompactTokens(tokenStats.cachedInputTokens)
              }
            />
          ) : null}
          {subagents !== null ? (
            <MetricCell
              label={<T context="subagent count metric label">Subagents</T>}
              value={`${subagents.active}/${subagents.total}`}
              highlight={subagents.active > 0}
            />
          ) : null}
          {costLabel !== null ? (
            <MetricCell label={<T context="session cost metric label">Cost</T>} value={costLabel} />
          ) : null}
        </div>
      ) : null}

      {!collapsed && quotaRows.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-border/65 px-2 py-1.5">
          {quotaRows.map((row) => (
            <QuotaRow key={row.id} row={row} now={now} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
