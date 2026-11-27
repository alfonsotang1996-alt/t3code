import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../../connection/runtime";

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
  readonly enabled?: boolean;
  readonly botToken?: string;
  readonly clearBotToken?: boolean;
  readonly chatId?: string;
  readonly notifyOnNeedsInput?: boolean;
  readonly notifyOnCompleted?: boolean;
  readonly notifyOnFailed?: boolean;
  readonly privacyMode?: boolean;
}

export interface TelegramTestMessageInput {
  readonly botToken?: string;
  readonly chatId?: string;
}

export class TelegramApiClientError extends Schema.TaggedError<TelegramApiClientError>()(
  "TelegramApiClientError",
  {
    message: Schema.String,
  },
) {}

const TELEGRAM_CONFIG_PATH = "/api/custom/telegram-notifications";
const TELEGRAM_TEST_PATH = "/api/custom/telegram-notifications/test";

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

const executeTelegramHttp = Effect.fn("telegramNotifications.executeHttp")(function* <T>(input: {
  readonly environmentId: EnvironmentId;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const httpClient = yield* HttpClient.HttpClient;
  const prepared = yield* registry
    .run(
      input.environmentId,
      Effect.flatMap(EnvironmentSupervisor.EnvironmentSupervisor, (supervisor) =>
        SubscriptionRef.get(supervisor.prepared),
      ),
    )
    .pipe(
      Effect.mapError(
        () => new TelegramApiClientError({ message: "Could not reach the selected environment." }),
      ),
    );

  if (Option.isNone(prepared)) {
    return yield* new TelegramApiClientError({
      message: "The selected environment is not connected.",
    });
  }

  const { httpBaseUrl, httpAuthorization } = prepared.value;
  const url = joinBaseUrl(httpBaseUrl, input.path);
  const headers: Record<string, string> = {};

  if (httpAuthorization?._tag === "Bearer") {
    headers.authorization = `Bearer ${httpAuthorization.token}`;
  } else if (httpAuthorization?._tag === "Dpop") {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    if (Option.isNone(signer)) {
      return yield* new TelegramApiClientError({
        message: "No authorization signer is available for this environment.",
      });
    }
    const proof = yield* signer.value
      .createProof({
        method: input.method,
        url,
        accessToken: httpAuthorization.accessToken,
      })
      .pipe(
        Effect.mapError(
          () =>
            new TelegramApiClientError({
              message: "Could not authorize the Telegram settings request.",
            }),
        ),
      );
    headers.authorization = `DPoP ${httpAuthorization.accessToken}`;
    headers.dpop = proof;
  }

  const baseRequest = HttpClientRequest.make(input.method)(url).pipe(
    HttpClientRequest.setHeaders(headers),
  );
  const request =
    input.body !== undefined
      ? HttpClientRequest.bodyJsonUnsafe(baseRequest, input.body)
      : baseRequest;

  const sendEffect = httpClient.execute(request).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError(
      () => new TelegramApiClientError({ message: "Could not contact the T3 Code server." }),
    ),
  );

  const response = yield* httpAuthorization === null
    ? sendEffect.pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
      )
    : sendEffect;

  const json = yield* response.json.pipe(
    Effect.map(
      (value) => value as (T & { readonly error?: string; readonly message?: string }) | null,
    ),
    Effect.orElseSucceed(() => null),
  );

  if (response.status < 200 || response.status >= 300 || json === null) {
    const message =
      (typeof json?.error === "string" && json.error.trim().length > 0 && json.error.trim()) ||
      (typeof json?.message === "string" &&
        json.message.trim().length > 0 &&
        json.message.trim()) ||
      `Request failed with HTTP ${response.status}.`;
    return yield* new TelegramApiClientError({ message });
  }

  return json as T;
});

export const readTelegramNotificationConfig = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:custom:telegram-notifications:read",
  execute: (input: { readonly environmentId: EnvironmentId }) =>
    executeTelegramHttp<TelegramNotificationPublicConfig>({
      environmentId: input.environmentId,
      method: "GET",
      path: TELEGRAM_CONFIG_PATH,
    }),
});

export const updateTelegramNotificationConfig = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:custom:telegram-notifications:update",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly patch: TelegramNotificationConfigPatch;
  }) =>
    executeTelegramHttp<TelegramNotificationPublicConfig>({
      environmentId: input.environmentId,
      method: "POST",
      path: TELEGRAM_CONFIG_PATH,
      body: input.patch,
    }),
});

export const sendTelegramTestNotification = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:custom:telegram-notifications:test",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly payload?: TelegramTestMessageInput;
  }) =>
    executeTelegramHttp<{ readonly ok: true }>({
      environmentId: input.environmentId,
      method: "POST",
      path: TELEGRAM_TEST_PATH,
      body: input.payload ?? {},
    }),
});
