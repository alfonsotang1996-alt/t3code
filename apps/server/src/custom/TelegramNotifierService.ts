import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type AgentAwarenessPhase,
  type AgentAwarenessState,
  type SubagentRequestAwareness,
  projectThreadAwarenessV2,
  subagentAwaitsUser,
  turnItemCanChangeUserWait,
} from "@t3tools/shared/agentAwareness";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";

const TELEGRAM_NOTIFICATIONS_SECRET_NAME = "custom-telegram-notifications";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_CONFIRM_MS = 3_000;
const MAX_PROJECT_TITLE_LENGTH = 80;
const MAX_THREAD_TITLE_LENGTH = 140;

export const TelegramNotificationStoredConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  botToken: Schema.String,
  chatId: Schema.String,
  notifyOnNeedsInput: Schema.Boolean,
  notifyOnCompleted: Schema.Boolean,
  notifyOnFailed: Schema.Boolean,
  privacyMode: Schema.Boolean,
});
export type TelegramNotificationStoredConfig = typeof TelegramNotificationStoredConfigSchema.Type;

const DEFAULT_TELEGRAM_NOTIFICATION_CONFIG: TelegramNotificationStoredConfig = {
  enabled: false,
  botToken: "",
  chatId: "",
  notifyOnNeedsInput: true,
  notifyOnCompleted: true,
  notifyOnFailed: true,
  privacyMode: false,
};

export interface TelegramNotificationPublicConfig {
  readonly enabled: boolean;
  readonly hasBotToken: boolean;
  readonly botTokenHint: string | null;
  readonly chatId: string;
  readonly notifyOnNeedsInput: boolean;
  readonly notifyOnCompleted: boolean;
  readonly notifyOnFailed: boolean;
  readonly privacyMode: boolean;
}

export interface TelegramNotificationConfigPatch {
  readonly enabled?: boolean | undefined;
  readonly botToken?: string | undefined;
  readonly clearBotToken?: boolean | undefined;
  readonly chatId?: string | undefined;
  readonly notifyOnNeedsInput?: boolean | undefined;
  readonly notifyOnCompleted?: boolean | undefined;
  readonly notifyOnFailed?: boolean | undefined;
  readonly privacyMode?: boolean | undefined;
}

export interface TelegramTestMessageInput {
  readonly botToken?: string | undefined;
  readonly chatId?: string | undefined;
}

export class TelegramNotificationError extends Schema.TaggedError<TelegramNotificationError>()(
  "TelegramNotificationError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}

export type TelegramNotifiablePhase =
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed";

export interface TelegramSendRequest {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
}

export type TelegramMessageSender = (
  input: TelegramSendRequest,
) => Effect.Effect<void, TelegramNotificationError>;

export class TelegramNotifierService extends Context.Service<
  TelegramNotifierService,
  {
    readonly getPublicConfig: Effect.Effect<
      TelegramNotificationPublicConfig,
      TelegramNotificationError
    >;
    readonly updateConfig: (
      patch: TelegramNotificationConfigPatch,
    ) => Effect.Effect<TelegramNotificationPublicConfig, TelegramNotificationError>;
    readonly sendTestMessage: (
      input?: TelegramTestMessageInput,
    ) => Effect.Effect<{ readonly ok: true }, TelegramNotificationError>;
    readonly evaluateThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/custom/TelegramNotifierService") {}

export function maskTelegramBotToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 8) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

function toPublicTelegramConfig(
  config: TelegramNotificationStoredConfig,
): TelegramNotificationPublicConfig {
  const trimmedToken = config.botToken.trim();
  return {
    enabled: config.enabled,
    hasBotToken: trimmedToken.length > 0,
    botTokenHint: maskTelegramBotToken(trimmedToken),
    chatId: config.chatId,
    notifyOnNeedsInput: config.notifyOnNeedsInput,
    notifyOnCompleted: config.notifyOnCompleted,
    notifyOnFailed: config.notifyOnFailed,
    privacyMode: config.privacyMode,
  };
}

function isNotifiablePhase(phase: AgentAwarenessPhase): phase is TelegramNotifiablePhase {
  return (
    phase === "waiting_for_approval" ||
    phase === "waiting_for_input" ||
    phase === "completed" ||
    phase === "failed"
  );
}

function isPhaseEnabledInConfig(
  phase: TelegramNotifiablePhase,
  config: Pick<
    TelegramNotificationStoredConfig,
    "notifyOnNeedsInput" | "notifyOnCompleted" | "notifyOnFailed"
  >,
): boolean {
  switch (phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return config.notifyOnNeedsInput;
    case "completed":
      return config.notifyOnCompleted;
    case "failed":
      return config.notifyOnFailed;
  }
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function formatTelegramNotificationMessage(input: {
  readonly phase: TelegramNotifiablePhase;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly privacyMode: boolean;
}): string {
  if (input.privacyMode) {
    switch (input.phase) {
      case "waiting_for_approval":
        return "🔐 T3 Code: A task needs your approval.";
      case "waiting_for_input":
        return "💬 T3 Code: A task is waiting for your input.";
      case "completed":
        return "✅ T3 Code: A task has completed.";
      case "failed":
        return "❌ T3 Code: A task failed or paused.";
    }
  }

  const header = (() => {
    switch (input.phase) {
      case "waiting_for_approval":
        return "🔐 Approval needed";
      case "waiting_for_input":
        return "💬 Input needed";
      case "completed":
        return "✅ Task completed";
      case "failed":
        return "❌ Task failed";
    }
  })();

  const projectLabel = truncateInline(
    input.projectTitle || "Untitled project",
    MAX_PROJECT_TITLE_LENGTH,
  );
  const threadLabel = truncateInline(
    input.threadTitle || "Untitled thread",
    MAX_THREAD_TITLE_LENGTH,
  );
  return `${header}\nProject: ${projectLabel}\nThread: ${threadLabel}`;
}

export const TELEGRAM_TEST_MESSAGE_TEXT =
  "🔔 T3 Code: Telegram notifications are connected and working.";

function isTurnItemPayload(
  payload: unknown,
): payload is Pick<OrchestrationV2TurnItem, "type" | "status"> {
  return (
    typeof payload === "object" && payload !== null && "type" in payload && "status" in payload
  );
}

function shouldEvaluateTelegramEvent(
  event: Pick<OrchestrationV2DomainEvent, "type"> & { readonly payload?: unknown },
): boolean {
  if (
    event.type === "thread.created" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "historyOrigin" in event.payload &&
    event.payload.historyOrigin === "v1_import"
  ) {
    return false;
  }
  switch (event.type) {
    case "thread.archived":
    case "thread.deleted":
    case "thread.settled":
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "subagent.updated":
    case "provider-thread.updated":
      return true;
    case "turn-item.updated":
      return (
        isTurnItemPayload(event.payload) &&
        (turnItemUpdateCanEndBackgroundWork(event.payload) ||
          turnItemCanChangeUserWait(event.payload))
      );
    default:
      return false;
  }
}

function snoozedCompletion(
  thread: AgentAwarenessThread,
  state: { readonly phase: string } | null,
): boolean {
  if (state?.phase !== "completed" || thread.latestRunCompletedAt == null) return false;
  const completedAt = DateTime.toEpochMillis(thread.latestRunCompletedAt);
  if (thread.snoozedAt != null && completedAt < DateTime.toEpochMillis(thread.snoozedAt)) {
    return false;
  }
  return isSnoozed(thread, completedAt);
}

function waitingApprovalId(thread: AgentAwarenessThread | null): RuntimeRequestId | undefined {
  return thread !== null && thread.archivedAt === null && subagentAwaitsUser(thread)
    ? thread.pendingRuntimeRequest?.id
    : undefined;
}

function buildNotificationIdentity(input: {
  readonly state: AgentAwarenessState;
  readonly thread: AgentAwarenessThread;
  readonly subagentWait: SubagentRequestAwareness | null;
}): string {
  const { state, thread, subagentWait } = input;
  if (state.phase === "waiting_for_approval" || state.phase === "waiting_for_input") {
    const requestId =
      thread.pendingRuntimeRequest?.id ?? subagentWait?.requestId ?? state.updatedAt;
    return `${state.phase}:${requestId}`;
  }
  return `${state.phase}:${thread.latestRunId ?? state.updatedAt}`;
}

const defaultTelegramMessageSender: TelegramMessageSender = Effect.fn(
  "TelegramNotifierService.sendMessage",
)(function* (input: TelegramSendRequest) {
  const httpClient = yield* HttpClient.HttpClient;
  const url = `${TELEGRAM_API_BASE_URL}/bot${encodeURIComponent(input.botToken)}/sendMessage`;
  const request = HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      chat_id: input.chatId,
      text: input.text,
      disable_web_page_preview: true,
    }),
  );
  const response = yield* httpClient.execute(request).pipe(
    Effect.timeout(TELEGRAM_SEND_TIMEOUT_MS),
    Effect.mapError(
      (cause) =>
        new TelegramNotificationError({
          message:
            cause._tag === "TimeoutError"
              ? "Timed out connecting to api.telegram.org."
              : "Could not reach api.telegram.org.",
        }),
    ),
  );
  const payload = yield* response.json.pipe(
    Effect.map((value) => value as { readonly ok?: boolean; readonly description?: string } | null),
    Effect.orElseSucceed(() => null),
  );
  if (response.status < 200 || response.status >= 300 || payload?.ok !== true) {
    const detail =
      typeof payload?.description === "string" && payload.description.trim().length > 0
        ? payload.description.trim()
        : `HTTP ${response.status}`;
    return yield* new TelegramNotificationError({
      message: `Telegram API rejected the message: ${detail}`,
      status: response.status,
    });
  }
}, Effect.provide(FetchHttpClient.layer));

const decodeStoredConfig = Schema.decodeUnknownSync(TelegramNotificationStoredConfigSchema);

function parseStoredConfigBytes(bytes: Uint8Array): TelegramNotificationStoredConfig {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return decodeStoredConfig({
      ...DEFAULT_TELEGRAM_NOTIFICATION_CONFIG,
      ...parsed,
    });
  } catch {
    return DEFAULT_TELEGRAM_NOTIFICATION_CONFIG;
  }
}

interface SubagentRequest {
  readonly topLevelThreadId: ThreadId;
  readonly requestId: RuntimeRequestId;
}

export interface TelegramNotifierOptions {
  readonly sendMessage?: TelegramMessageSender;
  readonly completionConfirmMs?: number;
}

/** @public */
export const make = Effect.fn("TelegramNotifierService.make")(function* (
  options: TelegramNotifierOptions = {},
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const scope = yield* Effect.scope;

  const sendMessage = options.sendMessage ?? defaultTelegramMessageSender;
  const completionConfirmMs = options.completionConfirmMs ?? DEFAULT_COMPLETION_CONFIRM_MS;
  const startedAt = (yield* DateTime.now).epochMilliseconds;

  const readStoredConfig = secrets.get(TELEGRAM_NOTIFICATIONS_SECRET_NAME).pipe(
    Effect.map((bytes) =>
      Option.isSome(bytes)
        ? parseStoredConfigBytes(bytes.value)
        : DEFAULT_TELEGRAM_NOTIFICATION_CONFIG,
    ),
    Effect.mapError(
      (cause) =>
        new TelegramNotificationError({
          message: `Failed to read Telegram notification settings: ${cause.message}`,
        }),
    ),
  );

  const writeStoredConfig = (config: TelegramNotificationStoredConfig) =>
    secrets
      .set(TELEGRAM_NOTIFICATIONS_SECRET_NAME, new TextEncoder().encode(JSON.stringify(config)))
      .pipe(
        Effect.mapError(
          (cause) =>
            new TelegramNotificationError({
              message: `Failed to save Telegram notification settings: ${cause.message}`,
            }),
        ),
      );

  const configRef = yield* Ref.make(
    yield* readStoredConfig.pipe(Effect.orElseSucceed(() => DEFAULT_TELEGRAM_NOTIFICATION_CONFIG)),
  );

  const lastNotifiedKeyByThread = new Map<ThreadId, string>();
  const observedLiveByThread = new Set<ThreadId>();
  const completionConfirmDeadlines = new Map<ThreadId, number>();
  const subagentRequests = new Map<ThreadId, SubagentRequest>();

  let enqueueThreadEvaluation: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  let scheduleCompletionConfirm: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const readAwarenessThread = (threadId: ThreadId) =>
    threads
      .getAgentAwarenessSnapshot(threadId)
      .pipe(Effect.map((snapshot) => snapshot.threads[0] ?? null));

  const findTopLevelThreadId = Effect.fnUntraced(function* (child: AgentAwarenessThread) {
    const seen = new Set<ThreadId>([child.id]);
    let current: AgentAwarenessThread | null = child;
    while (
      current?.lineage.relationshipToParent === "subagent" ||
      current?.lineage.sideChat === true
    ) {
      const parentId: ThreadId | null = current.lineage.parentThreadId;
      if (parentId === null || seen.has(parentId)) return null;
      seen.add(parentId);
      current = yield* readAwarenessThread(parentId);
    }
    return current?.id ?? null;
  });

  const trackSubagentRequest = Effect.fnUntraced(function* (
    threadId: ThreadId,
    threadShell: AgentAwarenessThread | null,
  ) {
    const requestId = waitingApprovalId(threadShell);
    const previous = subagentRequests.get(threadId);
    if (threadShell === null || requestId === undefined) {
      if (previous === undefined) return;
      subagentRequests.delete(threadId);
      yield* enqueueThreadEvaluation(previous.topLevelThreadId);
      return;
    }
    const topLevelThreadId =
      previous?.topLevelThreadId ?? (yield* findTopLevelThreadId(threadShell));
    if (topLevelThreadId === null) return;
    subagentRequests.set(threadId, { topLevelThreadId, requestId });
    yield* enqueueThreadEvaluation(topLevelThreadId);
  });

  const currentSubagentRequestFor = Effect.fnUntraced(function* (topLevelThreadId: ThreadId) {
    let pending: SubagentRequestAwareness | null = null;
    for (const [childId, entry] of subagentRequests) {
      if (entry.topLevelThreadId !== topLevelThreadId) continue;
      const child = yield* readAwarenessThread(childId);
      const requestId = waitingApprovalId(child);
      if (child === null || requestId === undefined) {
        subagentRequests.delete(childId);
        continue;
      }
      if (requestId !== entry.requestId) subagentRequests.set(childId, { ...entry, requestId });
      if (pending === null || DateTime.isGreaterThan(child.updatedAt, pending.updatedAt)) {
        pending = {
          requestId,
          updatedAt: child.updatedAt,
          waitsForInput: child.pendingRuntimeRequest?.kind === "user_input",
        };
      }
    }
    return pending;
  });

  const evaluateThreadUnsafe = Effect.fn("TelegramNotifierService.evaluateThread")(function* (
    threadId: ThreadId,
  ) {
    const threadShell = yield* readAwarenessThread(threadId);
    yield* trackSubagentRequest(threadId, threadShell);

    if (threadShell === null || threadShell.archivedAt !== null) {
      completionConfirmDeadlines.delete(threadId);
      return;
    }
    if (!isListedThreadLineage(threadShell.lineage)) {
      return;
    }

    const project = yield* projects.getById(threadShell.projectId);
    if (Option.isNone(project)) {
      completionConfirmDeadlines.delete(threadId);
      return;
    }

    const environmentId: EnvironmentId = yield* serverEnvironment.getEnvironmentId;
    const pendingSubagentRequest = yield* currentSubagentRequestFor(threadId);
    const awarenessInput = {
      environmentId,
      project: project.value,
      thread: threadShell,
    };
    const rawState = projectThreadAwarenessV2({
      ...awarenessInput,
      pendingSubagentRequest,
    });
    const state = snoozedCompletion(threadShell, rawState) ? null : rawState;
    const childDrivesWait =
      pendingSubagentRequest !== null &&
      state?.phase !== projectThreadAwarenessV2(awarenessInput)?.phase;
    const subagentWait = childDrivesWait ? pendingSubagentRequest : null;

    if (state === null || !isNotifiablePhase(state.phase)) {
      completionConfirmDeadlines.delete(threadId);
      if (state !== null && (state.phase === "starting" || state.phase === "running")) {
        observedLiveByThread.add(threadId);
      }
      return;
    }

    const notificationKey = buildNotificationIdentity({
      state,
      thread: threadShell,
      subagentWait,
    });

    if (lastNotifiedKeyByThread.get(threadId) === notificationKey) {
      completionConfirmDeadlines.delete(threadId);
      return;
    }

    // Skip stale terminal/waiting states that predate server startup so restarts never replay history.
    if (!observedLiveByThread.has(threadId)) {
      if (state.phase === "completed" || state.phase === "failed") {
        const completedAtMs =
          threadShell.latestRunCompletedAt != null
            ? DateTime.toEpochMillis(threadShell.latestRunCompletedAt)
            : null;
        if (completedAtMs === null || completedAtMs <= startedAt) {
          lastNotifiedKeyByThread.set(threadId, notificationKey);
          return;
        }
      } else {
        const waitTimestamp =
          subagentWait !== null
            ? DateTime.max(threadShell.updatedAt, subagentWait.updatedAt)
            : threadShell.updatedAt;
        if (DateTime.toEpochMillis(waitTimestamp) <= startedAt) {
          lastNotifiedKeyByThread.set(threadId, notificationKey);
          return;
        }
      }
    }

    // Brief confirmation hold on completed runs so immediate continuations do not double-alert.
    if (state.phase === "completed" && completionConfirmMs > 0) {
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const deadline = completionConfirmDeadlines.get(threadId);
      if (deadline === undefined) {
        completionConfirmDeadlines.set(threadId, nowMs + completionConfirmMs);
        yield* scheduleCompletionConfirm(threadId);
        return;
      }
      if (nowMs < deadline) {
        return;
      }
    }
    completionConfirmDeadlines.delete(threadId);

    const config = yield* Ref.get(configRef);
    if (
      !config.enabled ||
      config.botToken.trim().length === 0 ||
      config.chatId.trim().length === 0
    ) {
      return;
    }
    if (!isPhaseEnabledInConfig(state.phase, config)) {
      lastNotifiedKeyByThread.set(threadId, notificationKey);
      return;
    }

    const text = formatTelegramNotificationMessage({
      phase: state.phase,
      projectTitle: state.projectTitle,
      threadTitle: state.threadTitle,
      privacyMode: config.privacyMode,
    });

    // Mark before sending so transient failures do not spam the same transition repeatedly.
    lastNotifiedKeyByThread.set(threadId, notificationKey);
    yield* sendMessage({
      botToken: config.botToken.trim(),
      chatId: config.chatId.trim(),
      text,
    });
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    evaluateThreadUnsafe(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        return Effect.logWarning("telegram notification delivery failed", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const queued = new Set<ThreadId>();
  const coalescedWorker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(Effect.andThen(worker.enqueue(threadId))),
  );

  enqueueThreadEvaluation = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return coalescedWorker.enqueue(threadId);
    }).pipe(Effect.uninterruptible);

  scheduleCompletionConfirm = (threadId) =>
    Effect.forkIn(
      Effect.sleep(completionConfirmMs).pipe(
        Effect.andThen(enqueueThreadEvaluation(threadId)),
        Effect.ignoreCause,
      ),
      scope,
    ).pipe(Effect.asVoid);

  const drain = coalescedWorker.drain.pipe(Effect.andThen(worker.drain));

  const getPublicConfig = Ref.get(configRef).pipe(Effect.map(toPublicTelegramConfig));

  const updateConfig = Effect.fn("TelegramNotifierService.updateConfig")(function* (
    patch: TelegramNotificationConfigPatch,
  ) {
    const current = yield* Ref.get(configRef);
    const nextBotToken =
      patch.clearBotToken === true
        ? ""
        : patch.botToken !== undefined
          ? patch.botToken.trim()
          : current.botToken;
    const nextChatId = patch.chatId !== undefined ? patch.chatId.trim() : current.chatId;
    const nextConfig: TelegramNotificationStoredConfig = {
      enabled: patch.enabled ?? current.enabled,
      botToken: nextBotToken,
      chatId: nextChatId,
      notifyOnNeedsInput: patch.notifyOnNeedsInput ?? current.notifyOnNeedsInput,
      notifyOnCompleted: patch.notifyOnCompleted ?? current.notifyOnCompleted,
      notifyOnFailed: patch.notifyOnFailed ?? current.notifyOnFailed,
      privacyMode: patch.privacyMode ?? current.privacyMode,
    };
    yield* writeStoredConfig(nextConfig);
    yield* Ref.set(configRef, nextConfig);
    return toPublicTelegramConfig(nextConfig);
  });

  const sendTestMessage = Effect.fn("TelegramNotifierService.sendTestMessage")(function* (
    input?: TelegramTestMessageInput,
  ) {
    const current = yield* Ref.get(configRef);
    const botToken = (input?.botToken !== undefined ? input.botToken : current.botToken).trim();
    const chatId = (input?.chatId !== undefined ? input.chatId : current.chatId).trim();
    if (botToken.length === 0) {
      return yield* new TelegramNotificationError({
        message: "Bot Token is required before sending a test message.",
        status: 400,
      });
    }
    if (chatId.length === 0) {
      return yield* new TelegramNotificationError({
        message: "Chat ID is required before sending a test message.",
        status: 400,
      });
    }
    yield* sendMessage({
      botToken,
      chatId,
      text: TELEGRAM_TEST_MESSAGE_TEXT,
    });
    return { ok: true } as const;
  });

  const evaluateThread: TelegramNotifierService["Service"]["evaluateThread"] = (threadId) =>
    enqueueThreadEvaluation(threadId).pipe(Effect.andThen(drain));

  const start: TelegramNotifierService["Service"]["start"] = Effect.fn(
    "TelegramNotifierService.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) => {
        if (!shouldEvaluateTelegramEvent(event)) {
          return Effect.void;
        }
        return enqueueThreadEvaluation(event.threadId);
      }),
    );
  });

  return TelegramNotifierService.of({
    getPublicConfig,
    updateConfig,
    sendTestMessage,
    evaluateThread,
    drain,
    start,
  });
});

export const layer = Layer.effect(TelegramNotifierService, make());
