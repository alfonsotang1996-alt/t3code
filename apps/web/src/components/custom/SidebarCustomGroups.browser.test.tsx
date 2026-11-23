import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { readEnvironmentScope } from "~/state/session";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { CUSTOM_GROUPS_STORAGE_KEY, useCustomGroupsStore } from "./customGroupsStore";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const SHARED_THREADS: readonly [FakeThread, FakeThread] = [
  threadWithHistory("grp-thread-a", 1),
  threadWithHistory("grp-thread-b", 1),
];

function resetCustomGroups() {
  localStorage.removeItem(CUSTOM_GROUPS_STORAGE_KEY);
  useCustomGroupsStore.setState({
    groups: [],
    threadGroupByKey: {},
    draftGroupByDraftId: {},
  });
}

function customGroupsScope(): Disposable {
  resetCustomGroups();
  return {
    [Symbol.dispose]: () => {
      resetCustomGroups();
    },
  };
}

async function mountSidebarApp(threads: readonly FakeThread[]) {
  await page.viewport(1400, 900);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  await router.load();
  return render(<AppRoot router={router} />, { router: false });
}

describe("Sidebar custom groups", () => {
  it("creates a group from the header button, persists to localStorage, and survives remount", async () => {
    using _groups = customGroupsScope();
    const [first, second] = SHARED_THREADS;
    using _env = installFakeEnvironment([first, second]);

    {
      await using _app = await mountSidebarApp([first, second]);
      await expect.element(page.getByTestId("sidebar-new-custom-group-button")).toBeVisible();
      await userEvent.click(page.getByTestId("sidebar-new-custom-group-button"));

      const input = page.getByTestId("create-custom-group-name-input");
      await expect.element(input).toBeVisible();
      await userEvent.fill(input, "Urgent Bugs");
      await userEvent.click(page.getByTestId("create-custom-group-color-blue"));
      await userEvent.click(page.getByTestId("create-custom-group-submit"));

      const groupRow = page.getByTestId("sidebar-custom-group").filter({ hasText: "Urgent Bugs" });
      await expect.element(groupRow).toBeVisible();
      await expect.element(page.getByTestId("sidebar-custom-group-empty")).toBeVisible();
    }

    const stored = JSON.parse(localStorage.getItem(CUSTOM_GROUPS_STORAGE_KEY) ?? "null");
    expect(stored?.state?.groups).toHaveLength(1);
    expect(stored.state.groups[0].name).toBe("Urgent Bugs");
    expect(stored.state.groups[0].color).toBe("blue");

    await useCustomGroupsStore.persist.rehydrate();
    await using _appRemounted = await mountSidebarApp([first, second]);
    await expect
      .element(page.getByTestId("sidebar-custom-group").filter({ hasText: "Urgent Bugs" }))
      .toBeVisible();
  });

  it("assigns and removes threads via context menu and preserves collapse state across remount", async () => {
    using _groups = customGroupsScope();
    const [first, second] = SHARED_THREADS;
    using _env = installFakeEnvironment([first, second]);
    const group = useCustomGroupsStore.getState().createGroup("Backend", { color: "green" })!;

    {
      await using _app = await mountSidebarApp([first, second]);
      const threadRow = page.getByTestId("sidebar-row-card").filter({ hasText: second.title });
      await expect.element(threadRow).toBeVisible();

      const rect = threadRow.element().getBoundingClientRect();
      threadRow.element().dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 12,
          clientY: rect.top + 12,
        }),
      );

      const groupMenuItem = page.getByRole("menuitem", { name: "Group" });
      await expect.element(groupMenuItem).toBeVisible();
      await userEvent.hover(groupMenuItem);

      const assignItem = page.getByRole("menuitemradio", { name: "Backend" });
      await expect.element(assignItem).toBeVisible();
      await userEvent.click(assignItem);

      const secondKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, second.id));
      await vi.waitFor(() => {
        expect(useCustomGroupsStore.getState().getGroupIdForThread(secondKey)).toBe(group.id);
      });

      const toggleBtn = page
        .getByTestId("sidebar-custom-group-toggle")
        .filter({ hasText: "Backend" });
      await userEvent.click(toggleBtn);
      await expect.element(toggleBtn).toHaveAttribute("aria-expanded", "false");
      await expect
        .element(page.getByTestId("sidebar-row-card").filter({ hasText: second.title }))
        .not.toBeInTheDocument();
    }

    await useCustomGroupsStore.persist.rehydrate();
    {
      await using _appRemounted = await mountSidebarApp([first, second]);
      const toggleBtn = page
        .getByTestId("sidebar-custom-group-toggle")
        .filter({ hasText: "Backend" });
      await expect.element(toggleBtn).toHaveAttribute("aria-expanded", "false");
      await expect
        .element(page.getByTestId("sidebar-row-card").filter({ hasText: second.title }))
        .not.toBeInTheDocument();

      await userEvent.click(toggleBtn);
      await expect.element(toggleBtn).toHaveAttribute("aria-expanded", "true");
      const restoredRow = page.getByTestId("sidebar-row-card").filter({ hasText: second.title });
      await expect.element(restoredRow).toBeVisible();

      const rect = restoredRow.element().getBoundingClientRect();
      restoredRow.element().dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 12,
          clientY: rect.top + 12,
        }),
      );
      const groupMenuItem = page.getByRole("menuitem", { name: "Group" });
      await expect.element(groupMenuItem).toBeVisible();
      await userEvent.hover(groupMenuItem);

      const removeItem = page.getByRole("menuitem", { name: "Remove from group" });
      await expect.element(removeItem).toBeVisible();
      await userEvent.click(removeItem);

      const secondKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, second.id));
      await vi.waitFor(() => {
        expect(useCustomGroupsStore.getState().getGroupIdForThread(secondKey)).toBeNull();
      });
    }
  });

  it("supports inline rename via double-click and delete with undo preserving threads", async () => {
    using _groups = customGroupsScope();
    const [first, second] = SHARED_THREADS;
    using _env = installFakeEnvironment([first, second]);
    const secondKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, second.id));
    const group = useCustomGroupsStore.getState().createGroup("Temp Name", {
      assignThreadKeys: [secondKey],
    })!;

    await using _app = await mountSidebarApp([first, second]);
    const toggleBtn = page
      .getByTestId("sidebar-custom-group-toggle")
      .filter({ hasText: "Temp Name" });
    await expect.element(toggleBtn).toBeVisible();

    await userEvent.dblClick(toggleBtn);
    const renameInput = page.getByTestId("sidebar-custom-group-rename-input");
    await expect.element(renameInput).toBeVisible();
    await userEvent.fill(renameInput, "Aborted");
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByTestId("sidebar-custom-group-toggle").filter({ hasText: "Temp Name" }))
      .toBeVisible();

    await userEvent.dblClick(
      page.getByTestId("sidebar-custom-group-toggle").filter({ hasText: "Temp Name" }),
    );
    const renameInput2 = page.getByTestId("sidebar-custom-group-rename-input");
    await expect.element(renameInput2).toBeVisible();
    await userEvent.fill(renameInput2, "Renamed Group");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByTestId("sidebar-custom-group-toggle").filter({ hasText: "Renamed Group" }))
      .toBeVisible();

    const updatedToggle = page
      .getByTestId("sidebar-custom-group-toggle")
      .filter({ hasText: "Renamed Group" });
    const rect = updatedToggle.element().getBoundingClientRect();
    updatedToggle.element().dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 12,
        clientY: rect.top + 12,
      }),
    );

    const deleteItem = page.getByRole("menuitem", { name: "Delete group" });
    await expect.element(deleteItem).toBeVisible();
    await userEvent.click(deleteItem);

    await expect
      .element(page.getByTestId("sidebar-custom-group").filter({ hasText: "Renamed Group" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("sidebar-row-card").filter({ hasText: second.title }))
      .toBeVisible();

    const undoButton = page.getByRole("button", { name: "Undo" });
    await expect.element(undoButton).toBeVisible();
    await userEvent.click(undoButton);

    await expect
      .element(page.getByTestId("sidebar-custom-group").filter({ hasText: "Renamed Group" }))
      .toBeVisible();
    expect(useCustomGroupsStore.getState().getGroupIdForThread(secondKey)).toBe(group.id);
  });

  it("creates a new draft thread inside a group and reconciles membership on promotion", async () => {
    using _groups = customGroupsScope();
    const [first, second] = SHARED_THREADS;
    using _env = installFakeEnvironment([first, second]);
    const group = useCustomGroupsStore.getState().createGroup("Inbox Zero")!;

    await using _app = await mountSidebarApp([first, second]);
    const newThreadBtn = page.getByTestId("sidebar-custom-group-new-thread");
    await expect.element(newThreadBtn).toBeInTheDocument();
    await act(async () => {
      (newThreadBtn.element() as HTMLButtonElement).click();
    });

    await vi.waitFor(() => {
      expect(Object.keys(useCustomGroupsStore.getState().draftGroupByDraftId)).toHaveLength(1);
    });

    const [draftId] = Object.keys(useCustomGroupsStore.getState().draftGroupByDraftId);
    const draft = useComposerDraftStore.getState().draftThreadsByThreadKey[draftId!];
    expect(draft).toBeDefined();
    const draftThreadKey = scopedThreadKey(scopeThreadRef(draft!.environmentId, draft!.threadId));
    expect(useCustomGroupsStore.getState().getGroupIdForThread(draftThreadKey)).toBe(group.id);

    const promoted = threadWithHistory("grp-draft-promoted", 1);
    await act(async () => {
      useComposerDraftStore.setState((state) => ({
        draftThreadsByThreadKey: {
          ...state.draftThreadsByThreadKey,
          [draftId!]: {
            ...draft!,
            promotedTo: scopeThreadRef(ENVIRONMENT_ID, promoted.id),
          },
        },
      }));
    });

    const promotedKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, promoted.id));
    await vi.waitFor(() => {
      expect(useCustomGroupsStore.getState().getGroupIdForThread(promotedKey)).toBe(group.id);
      expect(useCustomGroupsStore.getState().draftGroupByDraftId[draftId!]).toBeUndefined();
    });
  });

  it("assigns and unassigns threads via pointer drag-and-drop", async () => {
    using _groups = customGroupsScope();
    const [first, second] = SHARED_THREADS;
    using _env = installFakeEnvironment([first, second]);
    const group = useCustomGroupsStore.getState().createGroup("Drag Target")!;

    const realPerfNow = performance.now.bind(performance);
    let perfOffsetMs = 0;
    using _perfNow = vi
      .spyOn(performance, "now")
      .mockImplementation(() => realPerfNow() + perfOffsetMs);

    await using _app = await mountSidebarApp([first, second]);
    const secondKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, second.id));
    const secondRow = page.getByTestId("sidebar-row-card").filter({ hasText: second.title });
    const groupHeader = page.getByTestId("sidebar-custom-group").filter({ hasText: "Drag Target" });
    await expect.element(secondRow).toBeVisible();
    await expect.element(groupHeader).toBeVisible();
    await vi.waitFor(() => {
      expect(readEnvironmentScope(ENVIRONMENT_ID, AuthOrchestrationOperateScope)).toBe(true);
    });

    // Advance past SidebarShiftGuard's 500ms settling window after initial shell arrival.
    perfOffsetMs += 600;

    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });

    using _release = {
      [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
    };

    const rowRect = secondRow.element().getBoundingClientRect();
    await act(() => {
      secondRow
        .element()
        .dispatchEvent(pointer("pointerdown", rowRect.left + 12, rowRect.top + 12));
      document.dispatchEvent(pointer("pointermove", rowRect.left + 12, rowRect.top + 2));
    });
    const headerRect = groupHeader.element().getBoundingClientRect();
    await act(() => {
      document.dispatchEvent(
        pointer(
          "pointermove",
          headerRect.left + headerRect.width / 2,
          headerRect.top + headerRect.height / 2,
        ),
      );
    });
    await act(() => {
      document.dispatchEvent(
        pointer(
          "pointerup",
          headerRect.left + headerRect.width / 2,
          headerRect.top + headerRect.height / 2,
        ),
      );
    });

    await vi.waitFor(() => {
      expect(useCustomGroupsStore.getState().getGroupIdForThread(secondKey)).toBe(group.id);
    });

    perfOffsetMs += 600;
    const groupedRow = page.getByTestId("sidebar-row-card").filter({ hasText: second.title });
    await expect.element(groupedRow).toBeVisible();
    const groupedRect = groupedRow.element().getBoundingClientRect();
    await act(() => {
      groupedRow
        .element()
        .dispatchEvent(pointer("pointerdown", groupedRect.left + 12, groupedRect.top + 12));
      document.dispatchEvent(pointer("pointermove", groupedRect.left + 12, groupedRect.top + 22));
    });

    const ungroupedZone = page.getByTestId("sidebar-custom-group-ungrouped");
    await expect.element(ungroupedZone).toBeVisible();
    const ungroupedRect = ungroupedZone.element().getBoundingClientRect();

    await act(() => {
      document.dispatchEvent(
        pointer(
          "pointermove",
          ungroupedRect.left + ungroupedRect.width / 2,
          ungroupedRect.top + ungroupedRect.height / 2,
        ),
      );
    });
    await act(() => {
      document.dispatchEvent(
        pointer(
          "pointerup",
          ungroupedRect.left + ungroupedRect.width / 2,
          ungroupedRect.top + ungroupedRect.height / 2,
        ),
      );
    });

    await vi.waitFor(() => {
      expect(useCustomGroupsStore.getState().getGroupIdForThread(secondKey)).toBeNull();
    });
  });
});
