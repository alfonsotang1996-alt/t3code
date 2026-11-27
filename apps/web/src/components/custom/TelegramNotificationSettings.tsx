import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { SendIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "../settings/settingsLayout";
import { useOptionalSettingsScope } from "../settings/SettingsScopeContext";
import { useSearchableSetting } from "../settings/settingsSearch";
import {
  readTelegramNotificationConfig,
  sendTelegramTestNotification,
  updateTelegramNotificationConfig,
  type TelegramNotificationPublicConfig,
} from "./telegramNotificationsApi";

const DEFAULT_PUBLIC_CONFIG: TelegramNotificationPublicConfig = {
  enabled: false,
  hasBotToken: false,
  botTokenHint: null,
  chatId: "",
  notifyOnNeedsInput: true,
  notifyOnCompleted: true,
  notifyOnFailed: true,
  privacyMode: false,
};

function extractErrorMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return fallback;
}

export function TelegramNotificationSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settingsScope = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = settingsScope?.target?.environmentId ?? primaryEnvironmentId;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);

  const readConfig = useAtomCommand(readTelegramNotificationConfig, { reportFailure: false });
  const updateConfig = useAtomCommand(updateTelegramNotificationConfig, { reportFailure: false });
  const sendTest = useAtomCommand(sendTelegramTestNotification, { reportFailure: false });

  const [config, setConfig] = useState<TelegramNotificationPublicConfig>(DEFAULT_PUBLIC_CONFIG);
  const [loadedEnvironmentId, setLoadedEnvironmentId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [botTokenInput, setBotTokenInput] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusFeedback, setStatusFeedback] = useState<{
    readonly tone: "success" | "error";
    readonly text: string;
  } | null>(null);

  const loadConfig = useEffectEvent((targetEnvironmentId: typeof environmentId) => {
    if (!targetEnvironmentId) return () => {};
    let cancelled = false;
    void readConfig({ environmentId: targetEnvironmentId }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setLoadError(null);
        setStatusFeedback(null);
        setConfig(result.value);
        setChatIdInput(result.value.chatId);
        setBotTokenInput("");
        setLoadedEnvironmentId(targetEnvironmentId);
      } else {
        setLoadError(
          extractErrorMessage(
            squashAtomCommandFailure(result),
            gt("Could not load Telegram notification settings."),
          ),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads server-owned secret-store config for the active environment
  useEffect(() => loadConfig(environmentId), [environmentId]);

  if (!environmentId) {
    return null;
  }

  const isLoading = loadedEnvironmentId !== environmentId && loadError === null;
  const controlsDisabled = !canWrite || isLoading || saving;
  const hasUnsavedCredentials =
    botTokenInput.trim().length > 0 || chatIdInput.trim() !== config.chatId;

  const persistPatch = async (
    patch: Parameters<typeof updateConfig>[0]["patch"],
    successToast?: string,
  ) => {
    setSaving(true);
    setStatusFeedback(null);
    const result = await updateConfig({ environmentId, patch });
    setSaving(false);
    if (result._tag === "Success") {
      setConfig(result.value);
      setChatIdInput(result.value.chatId);
      if (patch.botToken !== undefined || patch.clearBotToken === true) {
        setBotTokenInput("");
      }
      if (successToast) {
        toastManager.add({ type: "success", title: successToast });
      }
      return true;
    }
    const message = extractErrorMessage(
      squashAtomCommandFailure(result),
      gt("Could not save Telegram notification settings."),
    );
    setStatusFeedback({ tone: "error", text: message });
    toastManager.add({ type: "error", title: message });
    return false;
  };

  const handleSaveCredentials = async () => {
    await persistPatch(
      {
        ...(botTokenInput.trim().length > 0 ? { botToken: botTokenInput.trim() } : {}),
        chatId: chatIdInput.trim(),
      },
      gt("Telegram settings saved"),
    );
  };

  const handleClearBotToken = async () => {
    await persistPatch({ clearBotToken: true, enabled: false }, gt("Telegram Bot Token removed"));
  };

  const handleSendTest = async () => {
    setTesting(true);
    setStatusFeedback(null);
    const result = await sendTest({
      environmentId,
      payload: {
        ...(botTokenInput.trim().length > 0 ? { botToken: botTokenInput.trim() } : {}),
        ...(chatIdInput.trim().length > 0 ? { chatId: chatIdInput.trim() } : {}),
      },
    });
    setTesting(false);
    if (result._tag === "Success") {
      const text = gt("Test message sent to Telegram.");
      setStatusFeedback({ tone: "success", text });
      toastManager.add({ type: "success", title: text });
      return;
    }
    const message = extractErrorMessage(
      squashAtomCommandFailure(result),
      gt("Could not send Telegram test message."),
    );
    setStatusFeedback({ tone: "error", text: message });
    toastManager.add({ type: "error", title: message });
  };

  const canSendTest =
    !testing &&
    !isLoading &&
    canWrite &&
    (botTokenInput.trim().length > 0 || config.hasBotToken) &&
    chatIdInput.trim().length > 0;

  return (
    <div className="space-y-3">
      <SettingsRow
        {...searchableSetting("telegram-notifications")}
        description={
          loadError ??
          gt(
            "Send alerts directly from this server to Telegram (api.telegram.org) when a thread needs attention, finishes, or fails. Works without T3 Connect.",
          )
        }
        control={
          <Switch
            checked={config.enabled}
            disabled={controlsDisabled}
            onCheckedChange={(checked) => {
              void persistPatch({
                enabled: checked,
                ...(botTokenInput.trim().length > 0 ? { botToken: botTokenInput.trim() } : {}),
                ...(chatIdInput.trim() !== config.chatId ? { chatId: chatIdInput.trim() } : {}),
              });
            }}
            aria-label={gt("Telegram notifications")}
          />
        }
      />

      <div className="rounded-lg border border-border/70 bg-muted/20 p-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="telegram-bot-token">{gt("Bot Token")}</Label>
              {config.hasBotToken ? (
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={() => void handleClearBotToken()}
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {gt("Clear saved token")}
                </button>
              ) : null}
            </div>
            <Input
              id="telegram-bot-token"
              type="password"
              autoComplete="off"
              disabled={controlsDisabled}
              value={botTokenInput}
              onChange={(event) => setBotTokenInput(event.target.value)}
              placeholder={
                config.hasBotToken
                  ? gt("Saved ({hint}). Enter a new token to replace.", {
                      hint: config.botTokenHint ?? "••••",
                    })
                  : gt("123456789:AAH...")
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="telegram-chat-id">{gt("Chat ID")}</Label>
            <Input
              id="telegram-chat-id"
              type="text"
              autoComplete="off"
              disabled={controlsDisabled}
              value={chatIdInput}
              onChange={(event) => setChatIdInput(event.target.value)}
              placeholder={gt("e.g. 123456789")}
            />
          </div>
        </div>

        <div className="space-y-2.5 border-t border-border/60 pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{gt("Waiting for input or approval")}</div>
              <p className="text-xs text-muted-foreground">
                {gt("Notify immediately when an agent asks a question or requests approval.")}
              </p>
            </div>
            <Switch
              checked={config.notifyOnNeedsInput}
              disabled={controlsDisabled}
              onCheckedChange={(checked) => void persistPatch({ notifyOnNeedsInput: checked })}
              aria-label={gt("Waiting for input or approval")}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{gt("Task completed")}</div>
              <p className="text-xs text-muted-foreground">
                {gt("Notify when a thread finishes its run.")}
              </p>
            </div>
            <Switch
              checked={config.notifyOnCompleted}
              disabled={controlsDisabled}
              onCheckedChange={(checked) => void persistPatch({ notifyOnCompleted: checked })}
              aria-label={gt("Task completed")}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{gt("Task failed")}</div>
              <p className="text-xs text-muted-foreground">
                {gt("Notify when a run fails or pauses due to an error.")}
              </p>
            </div>
            <Switch
              checked={config.notifyOnFailed}
              disabled={controlsDisabled}
              onCheckedChange={(checked) => void persistPatch({ notifyOnFailed: checked })}
              aria-label={gt("Task failed")}
            />
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium">{gt("Privacy mode")}</div>
              <p className="text-xs text-muted-foreground">
                {gt(
                  "Hide project names and thread titles in Telegram alerts. Code and prompts are never sent.",
                )}
              </p>
            </div>
            <Switch
              checked={config.privacyMode}
              disabled={controlsDisabled}
              onCheckedChange={(checked) => void persistPatch({ privacyMode: checked })}
              aria-label={gt("Privacy mode")}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div className="text-xs text-muted-foreground">
            {statusFeedback ? (
              <span
                className={statusFeedback.tone === "error" ? "text-destructive" : "text-success"}
              >
                {statusFeedback.text}
              </span>
            ) : (
              gt("Bot Token is stored securely in the local server secret store.")
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canSendTest}
              onClick={() => void handleSendTest()}
            >
              <SendIcon className="size-3.5" />
              {testing ? gt("Sending...") : gt("Send test message")}
            </Button>
            <Button
              size="sm"
              disabled={controlsDisabled || !hasUnsavedCredentials}
              onClick={() => void handleSaveCredentials()}
            >
              {saving ? gt("Saving...") : gt("Save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
