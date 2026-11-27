import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { TelegramNotificationSettings } from "./TelegramNotificationSettings";
import {
  readTelegramNotificationConfig,
  sendTelegramTestNotification,
  updateTelegramNotificationConfig,
  type TelegramNotificationPublicConfig,
} from "./telegramNotificationsApi";

const ENV_ID = EnvironmentId.make("env-telegram-ui");

const mockRead = vi.fn();
const mockUpdate = vi.fn();
const mockTest = vi.fn();

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => ENV_ID,
}));

vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));

vi.mock("../settings/SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === readTelegramNotificationConfig) return mockRead;
    if (command === updateTelegramNotificationConfig) return mockUpdate;
    if (command === sendTelegramTestNotification) return mockTest;
    return vi.fn();
  },
}));

const baseConfig: TelegramNotificationPublicConfig = {
  enabled: false,
  hasBotToken: false,
  botTokenHint: null,
  chatId: "",
  notifyOnNeedsInput: true,
  notifyOnCompleted: true,
  notifyOnFailed: true,
  privacyMode: false,
};

describe("TelegramNotificationSettings", () => {
  it("loads config, saves credentials, and sends a test message", async () => {
    mockRead.mockResolvedValue(AsyncResult.success(baseConfig));
    mockUpdate.mockResolvedValue(
      AsyncResult.success({
        ...baseConfig,
        hasBotToken: true,
        botTokenHint: "••••1234",
        chatId: "99887766",
      }),
    );
    mockTest.mockResolvedValue(AsyncResult.success({ ok: true }));

    await using screen = await render(<TelegramNotificationSettings />);

    await expect.element(screen.getByText("Telegram notifications")).toBeVisible();

    const tokenInput = screen.getByLabelText("Bot Token");
    const chatIdInput = screen.getByLabelText("Chat ID");
    await userEvent.fill(tokenInput, "123456:AAHtoken1234");
    await userEvent.fill(chatIdInput, "99887766");

    await userEvent.click(screen.getByRole("button", { name: "Send test message" }));
    expect(mockTest).toHaveBeenCalledWith({
      environmentId: ENV_ID,
      payload: {
        botToken: "123456:AAHtoken1234",
        chatId: "99887766",
      },
    });
    await expect.element(page.getByText("Test message sent to Telegram.")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockUpdate).toHaveBeenCalledWith({
      environmentId: ENV_ID,
      patch: {
        botToken: "123456:AAHtoken1234",
        chatId: "99887766",
      },
    });
  });
});
