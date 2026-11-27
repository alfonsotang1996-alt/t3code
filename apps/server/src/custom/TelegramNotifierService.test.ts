import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TelegramNotifierService from "./TelegramNotifierService.ts";

const ENV_ID = EnvironmentId.make("env-telegram-test");
const PROJECT_ID = ProjectId.make("proj-telegram-test");
const THREAD_ID = ThreadId.make("thread-telegram-test");

function makeShell(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const now = DateTime.makeUnsafe("2026-11-27T12:00:00.000Z");
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix Telegram alerts",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

function makeHarness(initialShell: OrchestrationV2ThreadShell) {
  let currentShell: OrchestrationV2ThreadShell | null = initialShell;
  const secretsMap = new Map<string, Uint8Array>();
  const sentMessages: Array<TelegramNotifierService.TelegramSendRequest> = [];

  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromUndefinedOr(secretsMap.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        secretsMap.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        secretsMap.set(name, value);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(16)),
    remove: (name) =>
      Effect.sync(() => {
        secretsMap.delete(name);
      }),
  });

  const serverEnvironment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(ENV_ID),
  } as unknown as ServerEnvironment.ServerEnvironment["Service"]);

  const threadManagement = ThreadManagementService.ThreadManagementService.of({
    streamDomainEvents: Stream.empty,
    getAgentAwarenessSnapshot: (threadId?: ThreadId) =>
      Effect.succeed({
        threads:
          currentShell !== null && (threadId === undefined || currentShell.id === threadId)
            ? [currentShell]
            : [],
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"]);

  const projectService = ProjectService.ProjectService.of({
    getById: (id: ProjectId) =>
      Effect.succeed(
        id === PROJECT_ID
          ? Option.some({
              id: PROJECT_ID,
              title: "t3code",
            } as unknown as import("@t3tools/contracts").Project)
          : Option.none(),
      ),
  } as unknown as ProjectService.ProjectService["Service"]);

  const makeService = TelegramNotifierService.make({
    completionConfirmMs: 0,
    sendMessage: (req) =>
      Effect.sync(() => {
        sentMessages.push(req);
      }),
  }).pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
    Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
    Effect.provideService(ThreadManagementService.ThreadManagementService, threadManagement),
    Effect.provideService(ProjectService.ProjectService, projectService),
  );

  return {
    makeService,
    sentMessages,
    setShell: (next: OrchestrationV2ThreadShell | null) => {
      currentShell = next;
    },
  };
}

describe("TelegramNotifierService", () => {
  it("formats standard and privacy-mode messages without exposing code or prompts", () => {
    assert.strictEqual(
      TelegramNotifierService.formatTelegramNotificationMessage({
        phase: "waiting_for_approval",
        projectTitle: "t3code",
        threadTitle: "Add Telegram alerts",
        privacyMode: false,
      }),
      "🔐 Approval needed\nProject: t3code\nThread: Add Telegram alerts",
    );

    assert.strictEqual(
      TelegramNotifierService.formatTelegramNotificationMessage({
        phase: "waiting_for_input",
        projectTitle: "secret-repo",
        threadTitle: "Super secret title",
        privacyMode: true,
      }),
      "💬 T3 Code: A task is waiting for your input.",
    );

    assert.strictEqual(
      TelegramNotifierService.formatTelegramNotificationMessage({
        phase: "completed",
        projectTitle: "t3code",
        threadTitle: "Build DMG",
        privacyMode: true,
      }),
      "✅ T3 Code: A task has completed.",
    );
  });

  it("masks bot tokens cleanly", () => {
    assert.strictEqual(TelegramNotifierService.maskTelegramBotToken(""), null);
    assert.strictEqual(TelegramNotifierService.maskTelegramBotToken("short"), "••••");
    assert.strictEqual(
      TelegramNotifierService.maskTelegramBotToken("123456789:AAHxyz9876"),
      "••••9876",
    );
  });

  it.effect("persists config, masks bot token, and sends test messages", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = makeHarness(makeShell());
        const service = yield* harness.makeService;

        const initial = yield* service.getPublicConfig;
        assert.strictEqual(initial.enabled, false);
        assert.strictEqual(initial.hasBotToken, false);
        assert.strictEqual(initial.notifyOnNeedsInput, true);
        assert.strictEqual(initial.notifyOnCompleted, true);
        assert.strictEqual(initial.notifyOnFailed, true);
        assert.strictEqual(initial.privacyMode, false);

        const updated = yield* service.updateConfig({
          enabled: true,
          botToken: "123456789:AAHsecret1234",
          chatId: "99887766",
          privacyMode: true,
        });
        assert.strictEqual(updated.enabled, true);
        assert.strictEqual(updated.hasBotToken, true);
        assert.strictEqual(updated.botTokenHint, "••••1234");
        assert.strictEqual(updated.chatId, "99887766");
        assert.strictEqual(updated.privacyMode, true);

        yield* service.sendTestMessage();
        assert.strictEqual(harness.sentMessages.length, 1);
        assert.strictEqual(harness.sentMessages[0]?.botToken, "123456789:AAHsecret1234");
        assert.strictEqual(harness.sentMessages[0]?.chatId, "99887766");
        assert.strictEqual(
          harness.sentMessages[0]?.text,
          TelegramNotifierService.TELEGRAM_TEST_MESSAGE_TEXT,
        );
      }),
    ),
  );

  it.effect(
    "notifies on new transitions, deduplicates repeats, and skips pre-startup history",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-27T12:00:00.000Z")),
          );
          const past = DateTime.makeUnsafe("2026-11-27T11:55:00.000Z");
          const harness = makeHarness(
            makeShell({
              status: "completed",
              latestRunId: RunId.make("run-old"),
              latestRunCompletedAt: past,
              updatedAt: past,
            }),
          );
          const service = yield* harness.makeService;
          yield* service.updateConfig({
            enabled: true,
            botToken: "123456789:AAHsecret1234",
            chatId: "99887766",
          });

          // Pre-startup completed thread must not replay on restart.
          yield* service.evaluateThread(THREAD_ID);
          assert.strictEqual(harness.sentMessages.length, 0);

          // Thread starts running, then enters waiting_for_approval -> should notify once.
          harness.setShell(makeShell({ status: "running" }));
          yield* service.evaluateThread(THREAD_ID);
          assert.strictEqual(harness.sentMessages.length, 0);

          const req1 = RuntimeRequestId.make("req-1");
          harness.setShell(
            makeShell({
              status: "waiting",
              pendingRuntimeRequest: {
                id: req1,
                kind: "command_approval",
                createdAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
              } as unknown as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
              updatedAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
            }),
          );
          yield* service.evaluateThread(THREAD_ID);
          yield* service.evaluateThread(THREAD_ID);
          assert.strictEqual(harness.sentMessages.length, 1);
          assert.include(harness.sentMessages[0]?.text ?? "", "Approval needed");
          assert.include(harness.sentMessages[0]?.text ?? "", "t3code");

          // Completes run -> notifies once; respects privacyMode when enabled.
          yield* service.updateConfig({ privacyMode: true });
          harness.setShell(
            makeShell({
              status: "completed",
              latestRunId: RunId.make("run-2"),
              latestRunCompletedAt: DateTime.makeUnsafe("2099-01-01T00:01:00.000Z"),
              updatedAt: DateTime.makeUnsafe("2099-01-01T00:01:00.000Z"),
            }),
          );
          yield* service.evaluateThread(THREAD_ID);
          yield* service.evaluateThread(THREAD_ID);
          assert.strictEqual(harness.sentMessages.length, 2);
          assert.strictEqual(harness.sentMessages[1]?.text, "✅ T3 Code: A task has completed.");

          // Failed run when notifyOnFailed is disabled -> does not notify.
          yield* service.updateConfig({ notifyOnFailed: false });
          harness.setShell(
            makeShell({
              status: "failed",
              latestRunId: RunId.make("run-3"),
              latestRunCompletedAt: DateTime.makeUnsafe("2099-01-01T00:02:00.000Z"),
              updatedAt: DateTime.makeUnsafe("2099-01-01T00:02:00.000Z"),
            }),
          );
          yield* service.evaluateThread(THREAD_ID);
          assert.strictEqual(harness.sentMessages.length, 2);
        }),
      ),
  );
});
