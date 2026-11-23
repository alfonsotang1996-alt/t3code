import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ContextMenuItem, ScopedProjectRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import {
  resolveThreadActionProjectRef,
  type ChatThreadActionContext,
} from "../../lib/chatThreadActions";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarSection } from "../Sidebar.logic";
import {
  CUSTOM_GROUP_COLORS,
  type CustomGroupColor,
  type CustomSidebarGroup,
} from "./customGroupsStore";

export const CUSTOM_GROUP_UNGROUPED_DROP_ID = "__ungrouped__";

export function customGroupRowId(groupId: string): string {
  return `custom-group:${groupId}`;
}

export interface PartitionedCustomGroup<T> {
  readonly group: CustomSidebarGroup;
  readonly threads: readonly T[];
  readonly visibleThreads: readonly T[];
  readonly hiddenThreads: readonly T[];
  readonly hasActiveRouteThread: boolean;
}

interface CustomGroupPartitionResult<T> {
  readonly groupedSections: ReadonlyArray<PartitionedCustomGroup<T>>;
  readonly ungroupedActiveThreads: readonly T[];
  readonly ungroupedWorkingThreads: readonly T[];
  readonly groupedThreadKeys: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export function partitionThreadsForCustomGroups<
  T extends Pick<SidebarThreadSummary, "environmentId" | "id">,
>(input: {
  readonly groups: readonly CustomSidebarGroup[];
  readonly activeThreads: readonly T[];
  readonly workingThreads: readonly T[];
  readonly threadGroupByKey: Readonly<Record<string, string>>;
  readonly routeRowThreadKey: string | null;
}): CustomGroupPartitionResult<T> {
  const { groups, activeThreads, workingThreads, threadGroupByKey, routeRowThreadKey } = input;
  if (groups.length === 0) {
    return {
      groupedSections: [],
      ungroupedActiveThreads: activeThreads,
      ungroupedWorkingThreads: workingThreads,
      groupedThreadKeys: EMPTY_SET,
    };
  }

  const bucketByGroupId = new Map<string, T[]>();
  for (const group of groups) bucketByGroupId.set(group.id, []);

  const groupedThreadKeys = new Set<string>();
  const ungroupedActiveThreads: T[] = [];
  const ungroupedWorkingThreads: T[] = [];

  for (const thread of activeThreads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const groupId = threadGroupByKey[key];
    const bucket = groupId ? bucketByGroupId.get(groupId) : undefined;
    if (bucket) {
      bucket.push(thread);
      groupedThreadKeys.add(key);
    } else {
      ungroupedActiveThreads.push(thread);
    }
  }

  for (const thread of workingThreads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const groupId = threadGroupByKey[key];
    const bucket = groupId ? bucketByGroupId.get(groupId) : undefined;
    if (bucket) {
      bucket.push(thread);
      groupedThreadKeys.add(key);
    } else {
      ungroupedWorkingThreads.push(thread);
    }
  }

  const groupedSections = groups.map((group): PartitionedCustomGroup<T> => {
    const threads = bucketByGroupId.get(group.id) ?? [];
    const hasActiveRouteThread =
      routeRowThreadKey !== null &&
      threads.some(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey,
      );
    return {
      group,
      threads,
      visibleThreads: group.collapsed ? [] : threads,
      hiddenThreads: group.collapsed ? threads : [],
      hasActiveRouteThread,
    };
  });

  return {
    groupedSections,
    ungroupedActiveThreads,
    ungroupedWorkingThreads,
    groupedThreadKeys,
  };
}

export function resolveOrderedThreadKeysWithCustomGroups<
  T extends Pick<SidebarThreadSummary, "environmentId" | "id">,
>(input: {
  readonly defaultOrderedThreadKeys: readonly string[];
  readonly groupedSections: ReadonlyArray<PartitionedCustomGroup<T>>;
  readonly pinnedThreads: readonly T[];
  readonly ungroupedActiveThreads: readonly T[];
  readonly projectFolders: ReadonlyArray<{ readonly threads: readonly T[] }> | null;
  readonly visibleWorkingThreads: readonly T[];
  readonly visibleSnoozedThreads: readonly T[];
  readonly renderedSettledThreads: readonly T[];
}): readonly string[] {
  if (input.groupedSections.length === 0) return input.defaultOrderedThreadKeys;
  const orderedThreads = [
    ...input.pinnedThreads,
    ...input.groupedSections.flatMap((section) => section.visibleThreads),
    ...(input.projectFolders === null
      ? input.ungroupedActiveThreads
      : input.projectFolders.flatMap((folder) => folder.threads)),
    ...input.visibleWorkingThreads,
    ...input.visibleSnoozedThreads,
    ...input.renderedSettledThreads,
  ];
  return orderedThreads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
}

export function filterProjectFoldersForCustomGroups<
  TThread extends Pick<SidebarThreadSummary, "environmentId" | "id">,
  TFolder extends {
    readonly threads: readonly TThread[];
    readonly hiddenThreads: readonly TThread[];
  },
>(
  projectFolders: readonly TFolder[] | null,
  groupedThreadKeys: ReadonlySet<string>,
): readonly TFolder[] | null {
  if (projectFolders === null || groupedThreadKeys.size === 0) return projectFolders;
  return projectFolders.map((folder) => ({
    ...folder,
    threads: folder.threads.filter(
      (thread) =>
        !groupedThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    ),
    hiddenThreads: folder.hiddenThreads.filter(
      (thread) =>
        !groupedThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    ),
  }));
}

export function resolveGroupNewThreadProjectRef(input: {
  readonly groupId: string;
  readonly threads: readonly Pick<SidebarThreadSummary, "environmentId" | "id" | "projectId">[];
  readonly threadGroupByKey: Readonly<Record<string, string>>;
  readonly projects: readonly Pick<EnvironmentProject, "environmentId" | "id" | "archivedAt">[];
  readonly scopedProjectGroups: readonly {
    readonly memberProjectRefs: readonly ScopedProjectRef[];
  }[];
  readonly contextFallback: ChatThreadActionContext;
}): ScopedProjectRef | null {
  const liveProjectKeys = new Set(
    input.projects
      .filter((project) => project.archivedAt == null)
      .map((project) => `${project.environmentId}:${project.id}`),
  );
  for (const thread of input.threads) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (input.threadGroupByKey[key] !== input.groupId) continue;
    if (liveProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      return scopeProjectRef(thread.environmentId, thread.projectId);
    }
  }
  if (input.scopedProjectGroups.length === 1) {
    const onlyGroup = input.scopedProjectGroups[0]!;
    return onlyGroup.memberProjectRefs[0] ?? null;
  }
  return resolveThreadActionProjectRef(input.contextFallback);
}

type CustomGroupThreadMenuActionId =
  | "custom-group"
  | `custom-group:assign:${string}`
  | "custom-group:remove"
  | "custom-group:create";

function buildCustomGroupThreadMenuItem(
  input: {
    readonly groups: readonly CustomSidebarGroup[];
    readonly currentGroupId: string | null;
    readonly hasAnyAssigned?: boolean;
    readonly count?: number;
  },
  resolve: MessageResolver = m,
): ContextMenuItem<CustomGroupThreadMenuActionId> {
  const showRemove = input.hasAnyAssigned ?? input.currentGroupId !== null;
  return {
    id: "custom-group",
    label:
      input.count !== undefined
        ? resolve(msg("Group ({count})", { count: input.count }))
        : resolve(msg("Group", { $context: "submenu, assign thread to a custom group" })),
    icon: "folder",
    separatorBefore: true,
    children: [
      ...input.groups.map((group) => ({
        id: `custom-group:assign:${group.id}` as const,
        label: group.name,
        checked: input.currentGroupId === group.id,
      })),
      ...(showRemove
        ? [
            {
              id: "custom-group:remove" as const,
              label: resolve(msg("Remove from group")),
              separatorBefore: input.groups.length > 0,
            },
          ]
        : []),
      {
        id: "custom-group:create",
        label: resolve(msg("New group…")),
        icon: "folder-plus",
        separatorBefore: input.groups.length > 0 || showRemove,
      },
    ],
  };
}

export function appendCustomGroupThreadMenuItems<T extends string>(
  items: readonly ContextMenuItem<T>[],
  input: {
    readonly groups: readonly CustomSidebarGroup[];
    readonly currentGroupId: string | null;
    readonly hasAnyAssigned?: boolean;
    readonly count?: number;
  },
  resolve: MessageResolver = m,
): readonly ContextMenuItem<T | CustomGroupThreadMenuActionId>[] {
  const groupItem = buildCustomGroupThreadMenuItem(input, resolve);
  const copyIndex = items.findIndex((item) => item.id === "copy");
  if (copyIndex === -1) {
    return [...items, groupItem];
  }
  return [...items.slice(0, copyIndex), groupItem, ...items.slice(copyIndex)];
}

export function isCustomGroupThreadMenuActionId(
  actionId: string,
): actionId is CustomGroupThreadMenuActionId {
  return actionId === "custom-group" || actionId.startsWith("custom-group:");
}

export function parseCustomGroupThreadMenuAction(
  actionId: string,
):
  | { readonly kind: "assign"; readonly groupId: string }
  | { readonly kind: "remove" }
  | { readonly kind: "create" }
  | null {
  if (actionId === "custom-group:remove") return { kind: "remove" };
  if (actionId === "custom-group:create") return { kind: "create" };
  if (actionId.startsWith("custom-group:assign:")) {
    const groupId = actionId.slice("custom-group:assign:".length);
    return groupId.length > 0 ? { kind: "assign", groupId } : null;
  }
  return null;
}

const COLOR_LABEL: Record<CustomGroupColor, string> = {
  default: msg("Default", { $context: "custom group color option" }),
  blue: msg("Blue", { $context: "custom group color option" }),
  green: msg("Green", { $context: "custom group color option" }),
  amber: msg("Amber", { $context: "custom group color option" }),
  red: msg("Red", { $context: "custom group color option" }),
  purple: msg("Purple", { $context: "custom group color option" }),
  pink: msg("Pink", { $context: "custom group color option" }),
  cyan: msg("Cyan", { $context: "custom group color option" }),
};

type CustomGroupHeaderMenuActionId =
  | "new-thread"
  | "rename"
  | "color"
  | `color:${CustomGroupColor}`
  | "move-up"
  | "move-down"
  | "toggle-collapse"
  | "delete";

export function buildCustomGroupHeaderMenuItems(
  input: {
    readonly collapsed: boolean;
    readonly color: CustomGroupColor;
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
    readonly canNewThread: boolean;
  },
  resolve: MessageResolver = m,
): readonly ContextMenuItem<CustomGroupHeaderMenuActionId>[] {
  return [
    {
      id: "new-thread",
      label: resolve(msg("New thread in group")),
      icon: "message-square-plus",
      disabled: !input.canNewThread,
    },
    {
      id: "rename",
      label: resolve(msg("Rename group")),
      icon: "pencil",
      separatorBefore: true,
    },
    {
      id: "color",
      label: resolve(msg("Group color")),
      children: CUSTOM_GROUP_COLORS.map((color) => ({
        id: `color:${color}` as const,
        label: resolve(COLOR_LABEL[color]),
        checked: input.color === color,
      })),
    },
    {
      id: "toggle-collapse",
      label: input.collapsed ? resolve(msg("Expand group")) : resolve(msg("Collapse group")),
    },
    {
      id: "move-up",
      label: resolve(msg("Move up")),
      disabled: !input.canMoveUp,
      separatorBefore: true,
    },
    {
      id: "move-down",
      label: resolve(msg("Move down")),
      disabled: !input.canMoveDown,
    },
    {
      id: "delete",
      label: resolve(msg("Delete group")),
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export type CustomGroupDropTarget =
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "ungroup" };

export function resolveCustomGroupDropTargetFromHits(input: {
  readonly hits: ReadonlyArray<{
    readonly dropTargetAttr: string | null;
    readonly threadKey: string | null;
  }>;
  readonly activeThreadKey: string;
  readonly activeThreadGroupId: string | null;
  readonly threadGroupByKey: Readonly<Record<string, string>>;
  readonly sectionByThreadKey: ReadonlyMap<string, SidebarSection>;
  readonly groupIds: ReadonlySet<string>;
}): CustomGroupDropTarget | null {
  for (const hit of input.hits) {
    if (hit.threadKey === input.activeThreadKey) continue;
    if (hit.dropTargetAttr === CUSTOM_GROUP_UNGROUPED_DROP_ID) {
      return input.activeThreadGroupId !== null ? { kind: "ungroup" } : null;
    }
    if (hit.dropTargetAttr !== null && input.groupIds.has(hit.dropTargetAttr)) {
      return hit.dropTargetAttr !== input.activeThreadGroupId
        ? { kind: "group", groupId: hit.dropTargetAttr }
        : null;
    }
    if (hit.threadKey !== null) {
      const hitGroupId = input.threadGroupByKey[hit.threadKey];
      if (hitGroupId && input.groupIds.has(hitGroupId)) {
        return hitGroupId !== input.activeThreadGroupId
          ? { kind: "group", groupId: hitGroupId }
          : null;
      }
      if (input.sectionByThreadKey.get(hit.threadKey) === "active") {
        return input.activeThreadGroupId !== null ? { kind: "ungroup" } : null;
      }
    }
  }
  return null;
}
