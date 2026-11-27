import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as TelegramNotifierService from "./TelegramNotifierService.ts";

const TELEGRAM_NOTIFICATIONS_CONFIG_PATH = "/api/custom/telegram-notifications";
const TELEGRAM_NOTIFICATIONS_TEST_PATH = "/api/custom/telegram-notifications/test";

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const UpdateConfigBodySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  botToken: Schema.optional(Schema.String),
  clearBotToken: Schema.optional(Schema.Boolean),
  chatId: Schema.optional(Schema.String),
  notifyOnNeedsInput: Schema.optional(Schema.Boolean),
  notifyOnCompleted: Schema.optional(Schema.Boolean),
  notifyOnFailed: Schema.optional(Schema.Boolean),
  privacyMode: Schema.optional(Schema.Boolean),
});

const TestMessageBodySchema = Schema.Struct({
  botToken: Schema.optional(Schema.String),
  chatId: Schema.optional(Schema.String),
});

const decodeUpdateConfigBody = Schema.decodeUnknownEffect(UpdateConfigBodySchema);
const decodeTestMessageBody = Schema.decodeUnknownEffect(TestMessageBodySchema);

const authenticateTelegramRoute = Effect.fnUntraced(function* (scope: AuthEnvironmentScope) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
});

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status, headers: NO_STORE_HEADERS });

const layerGetConfigRoute = HttpRouter.add(
  "GET",
  TELEGRAM_NOTIFICATIONS_CONFIG_PATH,
  Effect.gen(function* () {
    yield* authenticateTelegramRoute(AuthOrchestrationReadScope);
    const telegram = yield* TelegramNotifierService.TelegramNotifierService;
    return yield* telegram.getPublicConfig.pipe(
      Effect.map((config) => HttpServerResponse.jsonUnsafe(config, { headers: NO_STORE_HEADERS })),
      Effect.catch((error) => Effect.succeed(jsonError(error.status ?? 500, error.message))),
    );
  }),
);

const layerUpdateConfigRoute = HttpRouter.add(
  "POST",
  TELEGRAM_NOTIFICATIONS_CONFIG_PATH,
  Effect.gen(function* () {
    yield* authenticateTelegramRoute(AuthSettingsWriteScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const parsed = yield* decodeUpdateConfigBody(rawBody).pipe(
      Effect.mapError(
        () =>
          new TelegramNotifierService.TelegramNotificationError({
            message: "Invalid Telegram notification configuration payload.",
            status: 400,
          }),
      ),
      Effect.result,
    );
    if (parsed._tag === "Failure") {
      return jsonError(parsed.failure.status ?? 400, parsed.failure.message);
    }
    const telegram = yield* TelegramNotifierService.TelegramNotifierService;
    return yield* telegram.updateConfig(parsed.success).pipe(
      Effect.map((config) => HttpServerResponse.jsonUnsafe(config, { headers: NO_STORE_HEADERS })),
      Effect.catch((error) => Effect.succeed(jsonError(error.status ?? 500, error.message))),
    );
  }),
);

const layerTestMessageRoute = HttpRouter.add(
  "POST",
  TELEGRAM_NOTIFICATIONS_TEST_PATH,
  Effect.gen(function* () {
    yield* authenticateTelegramRoute(AuthSettingsWriteScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
    const parsed = yield* decodeTestMessageBody(rawBody ?? {}).pipe(
      Effect.mapError(
        () =>
          new TelegramNotifierService.TelegramNotificationError({
            message: "Invalid Telegram test message payload.",
            status: 400,
          }),
      ),
      Effect.result,
    );
    if (parsed._tag === "Failure") {
      return jsonError(parsed.failure.status ?? 400, parsed.failure.message);
    }
    const telegram = yield* TelegramNotifierService.TelegramNotifierService;
    return yield* telegram.sendTestMessage(parsed.success).pipe(
      Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { headers: NO_STORE_HEADERS })),
      Effect.catch((error) => Effect.succeed(jsonError(error.status ?? 502, error.message))),
    );
  }),
);

export const layer = Layer.mergeAll(
  layerGetConfigRoute,
  layerUpdateConfigRoute,
  layerTestMessageRoute,
);
