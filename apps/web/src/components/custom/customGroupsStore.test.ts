import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const memoryStore = vi.hoisted(() => {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => backing.get(key) ?? null,
    key: (index) => [...backing.keys()][index] ?? null,
    removeItem: (key) => {
      backing.delete(key);
    },
    setItem: (key, value) => {
      backing.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return storage;
});

import {
  CUSTOM_GROUPS_STORAGE_KEY,
  CUSTOM_GROUP_COLORS,
  normalizePersistedCustomGroupsState,
  useCustomGroupsStore,
} from "./customGroupsStore";
import {
  CUSTOM_GROUP_UNGROUPED_DROP_ID,
  appendCustomGroupThreadMenuItems,
  buildCustomGroupHeaderMenuItems,
  customGroupRowId,
  filterProjectFoldersForCustomGroups,
  parseCustomGroupThreadMenuAction,
  partitionThreadsForCustomGroups,
  resolveCustomGroupDropTargetFromHits,
  resolveGroupNewThreadProjectRef,
  resolveOrderedThreadKeysWithCustomGroups,
} from "./SidebarCustomGroups.logic";

const ENV_A = EnvironmentId.make("env-a");
const PROJ_1 = ProjectId.make("proj-1");
const PROJ_2 = ProjectId.make("proj-2");

function makeThread(id: string, projectId: ProjectId = PROJ_1) {
  return {
    environmentId: ENV_A,
    id: ThreadId.make(id),
    projectId,
  };
}

function threadKeyOf(id: string): string {
  return scopedThreadKey(scopeThreadRef(ENV_A, ThreadId.make(id)));
}

function resetStoreAndStorage() {
  memoryStore.clear();
  useCustomGroupsStore.setState({
    groups: [],
    threadGroupByKey: {},
    draftGroupByDraftId: {},
  });
}

describe("customGroupsStore", () => {
  beforeEach(() => {
    resetStoreAndStorage();
  });

  afterEach(() => {
    resetStoreAndStorage();
  });

  it("normalizes malformed persisted state safely", () => {
    expect(normalizePersistedCustomGroupsState(null)).toEqual({
      groups: [],
      threadGroupByKey: {},
      draftGroupByDraftId: {},
    });

    const normalized = normalizePersistedCustomGroupsState({
      groups: [
        { id: "g1", name: "  Bug Fixes ", color: "blue", collapsed: true, createdAt: "" },
        { id: "g1", name: "Duplicate" },
        { id: "", name: "Empty id" },
        { id: "g2", name: "  " },
        { id: "g3", name: "Release", color: "not-a-color", collapsed: "yes" },
      ],
      threadGroupByKey: {
        "env-a:t1": "g1",
        "env-a:t2": "missing-group",
        "": "g1",
      },
      draftGroupByDraftId: {
        "draft-1": "g3",
        "draft-2": "ghost",
      },
    });

    expect(normalized.groups).toEqual([
      {
        id: "g1",
        name: "Bug Fixes",
        color: "blue",
        collapsed: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "g3",
        name: "Release",
        color: "default",
        collapsed: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(normalized.threadGroupByKey).toEqual({ "env-a:t1": "g1" });
    expect(normalized.draftGroupByDraftId).toEqual({ "draft-1": "g3" });
  });

  it("supports create, rename, color, collapse, reorder, and delete/restore without losing mappings", () => {
    const store = useCustomGroupsStore.getState();
    expect(store.createGroup("   ")).toBeNull();

    const t1 = threadKeyOf("t1");
    const t2 = threadKeyOf("t2");
    const alpha = store.createGroup("Alpha", { color: "green", assignThreadKeys: [t1] })!;
    const beta = store.createGroup("Beta", { color: "purple" })!;
    expect(alpha.name).toBe("Alpha");
    expect(alpha.color).toBe("green");
    expect(useCustomGroupsStore.getState().getGroupIdForThread(t1)).toBe(alpha.id);

    expect(useCustomGroupsStore.getState().renameGroup(alpha.id, "Alpha Renamed")).toBe(true);
    expect(useCustomGroupsStore.getState().renameGroup("missing", "X")).toBe(false);
    useCustomGroupsStore.getState().setGroupColor(alpha.id, "red");
    useCustomGroupsStore.getState().toggleGroupCollapsed(alpha.id);
    expect(useCustomGroupsStore.getState().groups[0]?.name).toBe("Alpha Renamed");
    expect(useCustomGroupsStore.getState().groups[0]?.color).toBe("red");
    expect(useCustomGroupsStore.getState().groups[0]?.collapsed).toBe(true);

    useCustomGroupsStore.getState().setGroupCollapsed(alpha.id, false);
    expect(useCustomGroupsStore.getState().groups[0]?.collapsed).toBe(false);

    useCustomGroupsStore.getState().moveGroup(beta.id, "up");
    expect(useCustomGroupsStore.getState().groups.map((g) => g.id)).toEqual([beta.id, alpha.id]);
    useCustomGroupsStore.getState().moveGroup(beta.id, "down");
    expect(useCustomGroupsStore.getState().groups.map((g) => g.id)).toEqual([alpha.id, beta.id]);

    useCustomGroupsStore.getState().assignThreadsToGroup([t2], alpha.id);
    const snapshot = useCustomGroupsStore.getState().deleteGroup(alpha.id);
    expect(snapshot).not.toBeNull();
    expect(useCustomGroupsStore.getState().groups.map((g) => g.id)).toEqual([beta.id]);
    expect(useCustomGroupsStore.getState().threadGroupByKey).toEqual({});

    useCustomGroupsStore.getState().restoreDeletedGroup(snapshot!);
    expect(useCustomGroupsStore.getState().groups.map((g) => g.id)).toEqual([alpha.id, beta.id]);
    expect(useCustomGroupsStore.getState().getGroupIdForThread(t1)).toBe(alpha.id);
    expect(useCustomGroupsStore.getState().getGroupIdForThread(t2)).toBe(alpha.id);

    useCustomGroupsStore.getState().unassignThreads([t1]);
    expect(useCustomGroupsStore.getState().getGroupIdForThread(t1)).toBeNull();
    expect(useCustomGroupsStore.getState().getGroupIdForThread(t2)).toBe(alpha.id);
  });

  it("reconciles draft bindings cleanly when promoted to a server thread", () => {
    const store = useCustomGroupsStore.getState();
    const group = store.createGroup("Work")!;
    store.setGroupCollapsed(group.id, true);

    const draftThreadKey = threadKeyOf("draft-thread-1");
    const serverThreadKey = threadKeyOf("server-thread-1");
    store.bindDraftToGroup("draft-1", draftThreadKey, group.id);

    expect(useCustomGroupsStore.getState().groups[0]?.collapsed).toBe(false);
    expect(useCustomGroupsStore.getState().threadGroupByKey[draftThreadKey]).toBe(group.id);
    expect(useCustomGroupsStore.getState().draftGroupByDraftId["draft-1"]).toBe(group.id);

    useCustomGroupsStore.getState().reconcileDraftGroup("draft-1", draftThreadKey, serverThreadKey);
    expect(useCustomGroupsStore.getState().threadGroupByKey[draftThreadKey]).toBeUndefined();
    expect(useCustomGroupsStore.getState().threadGroupByKey[serverThreadKey]).toBe(group.id);
    expect(useCustomGroupsStore.getState().draftGroupByDraftId["draft-1"]).toBeUndefined();
  });

  it("persists state into localStorage under CUSTOM_GROUPS_STORAGE_KEY", () => {
    const group = useCustomGroupsStore.getState().createGroup("Persisted", { color: "cyan" })!;
    useCustomGroupsStore.getState().assignThreadsToGroup([threadKeyOf("t-persisted")], group.id);

    const raw = localStorage.getItem(CUSTOM_GROUPS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.groups).toHaveLength(1);
    expect(parsed.state.groups[0].name).toBe("Persisted");
    expect(parsed.state.groups[0].color).toBe("cyan");
    expect(parsed.state.threadGroupByKey[threadKeyOf("t-persisted")]).toBe(group.id);
  });
});

describe("SidebarCustomGroups.logic", () => {
  const groups = [
    {
      id: "g1",
      name: "Focus",
      color: "blue" as const,
      collapsed: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "g2",
      name: "Later",
      color: "amber" as const,
      collapsed: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  it("partitions active and working threads across custom groups cleanly", () => {
    const tActive1 = makeThread("a1");
    const tActive2 = makeThread("a2");
    const tWork1 = makeThread("w1");
    const tWork2 = makeThread("w2");

    const partitioned = partitionThreadsForCustomGroups({
      groups,
      activeThreads: [tActive1, tActive2],
      workingThreads: [tWork1, tWork2],
      threadGroupByKey: {
        [threadKeyOf("a1")]: "g1",
        [threadKeyOf("w1")]: "g1",
        [threadKeyOf("a2")]: "g2",
      },
      routeRowThreadKey: threadKeyOf("a2"),
    });

    expect(partitioned.groupedSections[0]?.threads).toEqual([tActive1, tWork1]);
    expect(partitioned.groupedSections[0]?.visibleThreads).toEqual([tActive1, tWork1]);
    expect(partitioned.groupedSections[0]?.hiddenThreads).toEqual([]);
    expect(partitioned.groupedSections[1]?.visibleThreads).toEqual([]);
    expect(partitioned.groupedSections[1]?.hiddenThreads).toEqual([tActive2]);
    expect(partitioned.groupedSections[1]?.hasActiveRouteThread).toBe(true);
    expect(partitioned.ungroupedActiveThreads).toEqual([]);
    expect(partitioned.ungroupedWorkingThreads).toEqual([tWork2]);
    expect(partitioned.groupedThreadKeys.has(threadKeyOf("w1"))).toBe(true);
    expect(partitioned.groupedThreadKeys.has(threadKeyOf("w2"))).toBe(false);
  });

  it("computes ordered keys and filters boring-mode project folders", () => {
    const pinned = makeThread("p1");
    const activeGrouped = makeThread("a1");
    const activeUngrouped = makeThread("a2");
    const working = makeThread("w1");
    const snoozed = makeThread("z1");
    const settled = makeThread("s1");

    const partitioned = partitionThreadsForCustomGroups({
      groups,
      activeThreads: [activeGrouped, activeUngrouped],
      workingThreads: [working],
      threadGroupByKey: { [threadKeyOf("a1")]: "g1" },
      routeRowThreadKey: null,
    });

    const filteredFolders = filterProjectFoldersForCustomGroups(
      [{ threads: [activeGrouped, activeUngrouped], hiddenThreads: [activeGrouped] }],
      partitioned.groupedThreadKeys,
    );
    expect(filteredFolders).toEqual([{ threads: [activeUngrouped], hiddenThreads: [] }]);

    const ordered = resolveOrderedThreadKeysWithCustomGroups({
      defaultOrderedThreadKeys: ["fallback"],
      groupedSections: partitioned.groupedSections,
      pinnedThreads: [pinned],
      ungroupedActiveThreads: partitioned.ungroupedActiveThreads,
      projectFolders: filteredFolders,
      visibleWorkingThreads: partitioned.ungroupedWorkingThreads,
      visibleSnoozedThreads: [snoozed],
      renderedSettledThreads: [settled],
    });
    expect(ordered).toEqual([
      threadKeyOf("p1"),
      threadKeyOf("a1"),
      threadKeyOf("a2"),
      threadKeyOf("w1"),
      threadKeyOf("z1"),
      threadKeyOf("s1"),
    ]);
  });

  it("resolves project refs for new threads inside a group", () => {
    const tProj2 = makeThread("t2", PROJ_2);
    const ref = resolveGroupNewThreadProjectRef({
      groupId: "g1",
      threads: [tProj2],
      threadGroupByKey: { [threadKeyOf("t2")]: "g1" },
      projects: [
        { environmentId: ENV_A, id: PROJ_1, archivedAt: null },
        { environmentId: ENV_A, id: PROJ_2, archivedAt: null },
      ],
      scopedProjectGroups: [],
      contextFallback: {
        activeDraftThread: null,
        activeThread: undefined,
        defaultProjectRef: scopeProjectRef(ENV_A, PROJ_1),
        handleNewThread: async () => undefined,
      },
    });
    expect(ref).toEqual(scopeProjectRef(ENV_A, PROJ_2));

    const fallback = resolveGroupNewThreadProjectRef({
      groupId: "g1",
      threads: [],
      threadGroupByKey: {},
      projects: [{ environmentId: ENV_A, id: PROJ_1, archivedAt: null }],
      scopedProjectGroups: [{ memberProjectRefs: [scopeProjectRef(ENV_A, PROJ_1)] }],
      contextFallback: {
        activeDraftThread: null,
        activeThread: undefined,
        defaultProjectRef: null,
        handleNewThread: async () => undefined,
      },
    });
    expect(fallback).toEqual(scopeProjectRef(ENV_A, PROJ_1));
  });

  it("builds and parses thread and header context menus accurately", () => {
    const menu = appendCustomGroupThreadMenuItems(
      [
        { id: "rename", label: "Rename" },
        { id: "copy", label: "Copy" },
      ],
      { groups, currentGroupId: "g1", count: 2 },
    );
    expect(menu.map((item) => item.id)).toEqual(["rename", "custom-group", "copy"]);
    const groupItem = menu[1]!;
    expect(groupItem.children?.map((c) => c.id)).toEqual([
      "custom-group:assign:g1",
      "custom-group:assign:g2",
      "custom-group:remove",
      "custom-group:create",
    ]);

    expect(parseCustomGroupThreadMenuAction("custom-group:assign:g2")).toEqual({
      kind: "assign",
      groupId: "g2",
    });
    expect(parseCustomGroupThreadMenuAction("custom-group:remove")).toEqual({ kind: "remove" });
    expect(parseCustomGroupThreadMenuAction("custom-group:create")).toEqual({ kind: "create" });
    expect(parseCustomGroupThreadMenuAction("other")).toBeNull();

    const headerMenu = buildCustomGroupHeaderMenuItems({
      collapsed: true,
      color: "green",
      canMoveUp: false,
      canMoveDown: true,
      canNewThread: true,
    });
    const colorItem = headerMenu.find((item) => item.id === "color");
    expect(colorItem?.children).toHaveLength(CUSTOM_GROUP_COLORS.length);
    expect(customGroupRowId("g1")).toBe("custom-group:g1");
  });

  it("resolves pointer drop targets for groups, threads inside groups, and ungrouped zone", () => {
    const k1 = threadKeyOf("t1");
    const k2 = threadKeyOf("t2");
    const k3 = threadKeyOf("t3");
    const groupIds = new Set(["g1", "g2"]);
    const sectionByThreadKey = new Map([
      [k1, "active" as const],
      [k2, "active" as const],
      [k3, "active" as const],
    ]);

    expect(
      resolveCustomGroupDropTargetFromHits({
        hits: [{ dropTargetAttr: "g2", threadKey: null }],
        activeThreadKey: k1,
        activeThreadGroupId: "g1",
        threadGroupByKey: { [k1]: "g1", [k2]: "g2" },
        sectionByThreadKey,
        groupIds,
      }),
    ).toEqual({ kind: "group", groupId: "g2" });

    expect(
      resolveCustomGroupDropTargetFromHits({
        hits: [{ dropTargetAttr: CUSTOM_GROUP_UNGROUPED_DROP_ID, threadKey: null }],
        activeThreadKey: k1,
        activeThreadGroupId: "g1",
        threadGroupByKey: { [k1]: "g1" },
        sectionByThreadKey,
        groupIds,
      }),
    ).toEqual({ kind: "ungroup" });

    expect(
      resolveCustomGroupDropTargetFromHits({
        hits: [{ dropTargetAttr: null, threadKey: k3 }],
        activeThreadKey: k1,
        activeThreadGroupId: "g1",
        threadGroupByKey: { [k1]: "g1" },
        sectionByThreadKey,
        groupIds,
      }),
    ).toEqual({ kind: "ungroup" });
  });
});
