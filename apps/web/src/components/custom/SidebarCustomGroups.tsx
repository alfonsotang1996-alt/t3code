import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { ChevronDownIcon, FolderIcon, FolderPlusIcon, PlusIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore } from "../../composerDraftStore";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import {
  resolveSidebarFolderDot,
  resolveThreadLastVisitedAt,
  type SidebarSection,
} from "../Sidebar.logic";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CUSTOM_GROUP_COLORS,
  useCustomGroupsStore,
  type CustomGroupColor,
  type CustomSidebarGroup,
} from "./customGroupsStore";
import {
  CUSTOM_GROUP_UNGROUPED_DROP_ID,
  buildCustomGroupHeaderMenuItems,
  customGroupRowId,
  filterProjectFoldersForCustomGroups,
  parseCustomGroupThreadMenuAction,
  partitionThreadsForCustomGroups,
  resolveCustomGroupDropTargetFromHits,
  resolveOrderedThreadKeysWithCustomGroups,
  type CustomGroupDropTarget,
  type PartitionedCustomGroup,
} from "./SidebarCustomGroups.logic";

const COLOR_TEXT_CLASS: Record<CustomGroupColor, string> = {
  default: "text-muted-foreground",
  blue: "text-blue-500",
  green: "text-emerald-500",
  amber: "text-amber-500",
  red: "text-rose-500",
  purple: "text-purple-500",
  pink: "text-pink-500",
  cyan: "text-cyan-500",
};

const COLOR_SWATCH_CLASS: Record<CustomGroupColor, string> = {
  default: "bg-muted-foreground/70",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-rose-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  cyan: "bg-cyan-500",
};

const GROUP_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const GROUP_DOT_LABEL = {
  attention: msg(", needs you", { $context: "custom group status, read after its name" }),
  failed: msg(", failed", { $context: "custom group status, read after its name" }),
  unread: msg(", done", { $context: "custom group status, read after its name" }),
  working: msg(", working", { $context: "custom group status, read after its name" }),
} as const;

interface CustomGroupDragState {
  active: boolean;
  isGroupedThread: boolean;
  targetId: string | null;
}

const IDLE_DRAG_STATE: CustomGroupDragState = {
  active: false,
  isGroupedThread: false,
  targetId: null,
};

let customGroupDragState: CustomGroupDragState = IDLE_DRAG_STATE;
const dragListeners = new Set<() => void>();

function emitDragState() {
  for (const listener of dragListeners) {
    listener();
  }
}

function subscribeDragState(listener: () => void) {
  dragListeners.add(listener);
  return () => {
    dragListeners.delete(listener);
  };
}

function getDragStateSnapshot() {
  return customGroupDragState;
}

function setDragState(next: CustomGroupDragState) {
  if (
    customGroupDragState.active === next.active &&
    customGroupDragState.isGroupedThread === next.isGroupedThread &&
    customGroupDragState.targetId === next.targetId
  ) {
    return;
  }
  customGroupDragState = next;
  emitDragState();
}

function useCustomGroupDragState(): CustomGroupDragState {
  return useSyncExternalStore(subscribeDragState, getDragStateSnapshot, getDragStateSnapshot);
}

interface CustomGroupDragHit {
  readonly dropTargetAttr: string | null;
  readonly threadKey: string | null;
}

function collectCustomGroupHitsFromPoint(point: { x: number; y: number }): CustomGroupDragHit[] {
  if (typeof document === "undefined" || typeof document.elementsFromPoint !== "function") {
    return [];
  }
  const elements = document.elementsFromPoint(point.x, point.y);
  const hits: CustomGroupDragHit[] = [];
  for (const el of elements) {
    if (!(el instanceof Element)) continue;
    const dropTargetEl = el.closest<HTMLElement>("[data-custom-group-drop-target]");
    const threadItemEl = el.closest<HTMLElement>("[data-thread-item]");
    const dropTargetAttr = dropTargetEl?.dataset.customGroupDropTarget ?? null;
    const threadKey = threadItemEl?.dataset.threadItem ?? null;
    if (dropTargetAttr !== null || threadKey !== null) {
      hits.push({ dropTargetAttr, threadKey });
    }
  }
  return hits;
}

function dropTargetToId(target: CustomGroupDropTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "ungroup" ? CUSTOM_GROUP_UNGROUPED_DROP_ID : target.groupId;
}

interface CustomGroupDragContext {
  activeThreadKey: string | null;
  sectionByThreadKey: ReadonlyMap<string, SidebarSection>;
}

export function updateCustomGroupDrag(
  point: { x: number; y: number },
  context: CustomGroupDragContext,
): string | null {
  const { groups, threadGroupByKey } = useCustomGroupsStore.getState();
  if (groups.length === 0 || !context.activeThreadKey) {
    setDragState(IDLE_DRAG_STATE);
    return null;
  }
  const activeThreadGroupId = threadGroupByKey[context.activeThreadKey] ?? null;
  const hits = collectCustomGroupHitsFromPoint(point);
  const target = resolveCustomGroupDropTargetFromHits({
    hits,
    activeThreadKey: context.activeThreadKey,
    activeThreadGroupId,
    threadGroupByKey,
    sectionByThreadKey: context.sectionByThreadKey,
    groupIds: new Set(groups.map((group) => group.id)),
  });
  const targetId = dropTargetToId(target);
  setDragState({
    active: true,
    isGroupedThread: activeThreadGroupId !== null,
    targetId,
  });
  return targetId;
}

export function commitCustomGroupDrop(
  point: { x: number; y: number },
  threadKeys: readonly string[],
  context: CustomGroupDragContext,
): boolean {
  const { groups, threadGroupByKey, assignThreadsToGroup, unassignThreads } =
    useCustomGroupsStore.getState();
  if (groups.length === 0 || !context.activeThreadKey || threadKeys.length === 0) {
    setDragState(IDLE_DRAG_STATE);
    return false;
  }
  const activeThreadGroupId = threadGroupByKey[context.activeThreadKey] ?? null;
  const hits = collectCustomGroupHitsFromPoint(point);
  const target = resolveCustomGroupDropTargetFromHits({
    hits,
    activeThreadKey: context.activeThreadKey,
    activeThreadGroupId,
    threadGroupByKey,
    sectionByThreadKey: context.sectionByThreadKey,
    groupIds: new Set(groups.map((group) => group.id)),
  });
  setDragState(IDLE_DRAG_STATE);
  if (target === null) {
    return false;
  }
  if (target.kind === "ungroup") {
    unassignThreads(threadKeys);
    return true;
  }
  assignThreadsToGroup(threadKeys, target.groupId);
  return true;
}

export function endCustomGroupDrag() {
  setDragState(IDLE_DRAG_STATE);
}

interface CreateGroupModalState {
  id: number;
  initialName: string;
  assignThreadKeys: readonly string[];
}

interface DeleteGroupModalState {
  id: number;
  groupId: string;
  groupName: string;
  settleableThreadKeys: readonly string[];
  settleableThreadRefs: readonly ScopedThreadRef[];
  canSettle: boolean;
  onSettleThreads: (threadKeys: readonly string[]) => void;
  onUnsettleThreads: (threadRefs: readonly ScopedThreadRef[]) => void;
}

let nextModalRequestId = 1;
let createGroupModalState: CreateGroupModalState | null = null;
let deleteGroupModalState: DeleteGroupModalState | null = null;
const modalListeners = new Set<() => void>();

function emitModalState() {
  for (const listener of modalListeners) {
    listener();
  }
}

function subscribeModalState(listener: () => void) {
  modalListeners.add(listener);
  return () => {
    modalListeners.delete(listener);
  };
}

function getModalStateSnapshot() {
  return createGroupModalState;
}

function getDeleteModalStateSnapshot() {
  return deleteGroupModalState;
}

function requestCreateCustomGroup(options?: {
  initialName?: string;
  assignThreadKeys?: readonly string[];
}) {
  createGroupModalState = {
    id: nextModalRequestId++,
    initialName: options?.initialName ?? "",
    assignThreadKeys: options?.assignThreadKeys ?? [],
  };
  emitModalState();
}

function closeCreateCustomGroupModal() {
  if (createGroupModalState === null) return;
  createGroupModalState = null;
  emitModalState();
}

function requestDeleteCustomGroup(input: {
  groupId: string;
  groupName: string;
  settleableThreadKeys: readonly string[];
  settleableThreadRefs: readonly ScopedThreadRef[];
  canSettle: boolean;
  onSettleThreads: (threadKeys: readonly string[]) => void;
  onUnsettleThreads: (threadRefs: readonly ScopedThreadRef[]) => void;
}) {
  deleteGroupModalState = {
    id: nextModalRequestId++,
    ...input,
  };
  emitModalState();
}

function closeDeleteCustomGroupModal() {
  if (deleteGroupModalState === null) return;
  deleteGroupModalState = null;
  emitModalState();
}

export function handleCustomGroupThreadMenuSelection(
  actionId: string,
  threadKeys: readonly string[],
): boolean {
  const parsed = parseCustomGroupThreadMenuAction(actionId);
  if (parsed === null) {
    return false;
  }
  if (parsed.kind === "assign") {
    useCustomGroupsStore.getState().assignThreadsToGroup(threadKeys, parsed.groupId);
    return true;
  }
  if (parsed.kind === "remove") {
    useCustomGroupsStore.getState().unassignThreads(threadKeys);
    return true;
  }
  requestCreateCustomGroup({ assignThreadKeys: threadKeys });
  return true;
}

function getColorLabel(gt: ReturnType<typeof useGT>, color: CustomGroupColor): string {
  switch (color) {
    case "default":
      return gt("Default", { $context: "custom group color option" });
    case "blue":
      return gt("Blue", { $context: "custom group color option" });
    case "green":
      return gt("Green", { $context: "custom group color option" });
    case "amber":
      return gt("Amber", { $context: "custom group color option" });
    case "red":
      return gt("Red", { $context: "custom group color option" });
    case "purple":
      return gt("Purple", { $context: "custom group color option" });
    case "pink":
      return gt("Pink", { $context: "custom group color option" });
    case "cyan":
      return gt("Cyan", { $context: "custom group color option" });
  }
}

function CreateCustomGroupDialogForm({
  request,
  onClose,
}: {
  request: CreateGroupModalState;
  onClose: () => void;
}) {
  const gt = useGT();
  const [name, setName] = useState(request.initialName);
  const [color, setColor] = useState<CustomGroupColor>("default");

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    useCustomGroupsStore.getState().createGroup(trimmed, {
      color,
      assignThreadKeys: request.assignThreadKeys,
    });
    onClose();
  };

  return (
    <form className="flex min-h-0 flex-col" onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>{gt("New group")}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-group-name-input">{gt("Group name")}</Label>
            <Input
              id="custom-group-name-input"
              data-testid="create-custom-group-name-input"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={gt("e.g. Bug fixes, Release")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">{gt("Group color")}</span>
            <div className="flex flex-wrap items-center gap-2">
              {CUSTOM_GROUP_COLORS.map((option) => {
                const selected = color === option;
                const colorLabel = getColorLabel(gt, option);
                return (
                  <Tooltip key={option}>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={colorLabel}
                          aria-pressed={selected}
                          data-testid={`create-custom-group-color-${option}`}
                          onClick={() => setColor(option)}
                          className={cn(
                            "flex size-6 items-center justify-center rounded-full border transition-transform hover:scale-110",
                            selected ? "border-ring ring-2 ring-ring/40" : "border-border",
                          )}
                        />
                      }
                    >
                      <span className={cn("size-3.5 rounded-full", COLOR_SWATCH_CLASS[option])} />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{colorLabel}</TooltipPopup>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {gt("Cancel")}
        </Button>
        <Button
          type="submit"
          data-testid="create-custom-group-submit"
          disabled={name.trim().length === 0}
        >
          {gt("Create")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CreateCustomGroupDialog() {
  const request = useSyncExternalStore(
    subscribeModalState,
    getModalStateSnapshot,
    getModalStateSnapshot,
  );

  if (request === null) {
    return null;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeCreateCustomGroupModal();
      }}
    >
      <DialogPopup>
        <CreateCustomGroupDialogForm
          key={request.id}
          request={request}
          onClose={closeCreateCustomGroupModal}
        />
      </DialogPopup>
    </Dialog>
  );
}

function deleteGroupWithUndoToast(groupId: string, gt: ReturnType<typeof useGT>) {
  const snapshot = useCustomGroupsStore.getState().deleteGroup(groupId);
  if (!snapshot) return;
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: gt('Deleted group "{name}"', { name: snapshot.group.name }),
      description: gt("Threads remain available in the sidebar."),
      actionProps: {
        children: gt("Undo"),
        onClick: () => {
          useCustomGroupsStore.getState().restoreDeletedGroup(snapshot);
        },
      },
    }),
  );
}

function DeleteCustomGroupDialog() {
  const gt = useGT();
  const request = useSyncExternalStore(
    subscribeModalState,
    getDeleteModalStateSnapshot,
    getDeleteModalStateSnapshot,
  );

  if (request === null) {
    return null;
  }

  const count = request.settleableThreadKeys.length;

  const handleKeepThreads = () => {
    deleteGroupWithUndoToast(request.groupId, gt);
    closeDeleteCustomGroupModal();
  };

  const handleDeleteAndSettle = () => {
    const snapshot = useCustomGroupsStore.getState().deleteGroup(request.groupId);
    if (snapshot) {
      const settledKeys = request.settleableThreadKeys;
      const settledRefs = request.settleableThreadRefs;
      request.onSettleThreads(settledKeys);
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: gt('Deleted group "{name}"', { name: snapshot.group.name }),
          description: gt("Settled {count} threads in this group.", { count }),
          actionProps: {
            children: gt("Undo"),
            onClick: () => {
              useCustomGroupsStore.getState().restoreDeletedGroup(snapshot);
              request.onUnsettleThreads(settledRefs);
            },
          },
        }),
      );
    }
    closeDeleteCustomGroupModal();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeDeleteCustomGroupModal();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{gt('Delete group "{name}"?', { name: request.groupName })}</DialogTitle>
          <DialogDescription>
            {gt(
              "This group has {count} active threads. You can settle them together or keep them in the sidebar.",
              { count },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={closeDeleteCustomGroupModal}>
            {gt("Cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="delete-custom-group-keep-threads"
            onClick={handleKeepThreads}
          >
            {gt("Keep threads")}
          </Button>
          <Button
            type="button"
            variant="default"
            data-testid="delete-custom-group-and-settle"
            disabled={!request.canSettle}
            onClick={handleDeleteAndSettle}
          >
            {gt("Delete & settle ({count})", { count })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SidebarCustomGroupHeaderButton() {
  const gt = useGT();
  return (
    <SidebarHeaderIconButton
      label={gt("New group")}
      tooltip={gt("New group")}
      data-testid="sidebar-new-custom-group-button"
      onClick={() => requestCreateCustomGroup()}
    >
      <FolderPlusIcon className="size-3.5" />
    </SidebarHeaderIconButton>
  );
}

interface SidebarCustomGroupHeaderProps {
  group: CustomSidebarGroup;
  threads: readonly EnvironmentThreadShell[];
  hiddenThreads: readonly EnvironmentThreadShell[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  canNewThread: boolean;
  canSettleThreads: (threads: readonly EnvironmentThreadShell[]) => boolean;
  onNewThreadInGroup: (groupId: string) => void | Promise<void>;
  onSettleThreads: (threadKeys: readonly string[]) => void;
  onUnsettleThreads: (threadRefs: readonly ScopedThreadRef[]) => void;
}

function SidebarCustomGroupHeader({
  group,
  threads,
  hiddenThreads,
  canMoveUp,
  canMoveDown,
  canNewThread,
  canSettleThreads,
  onNewThreadInGroup,
  onSettleThreads,
  onUnsettleThreads,
}: SidebarCustomGroupHeaderProps) {
  const gt = useGT();
  const m = useMessages();
  const dragState = useCustomGroupDragState();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const settledRef = useRef(false);

  const totalCount = threads.length;
  const settleableThreads = threads.filter((thread) => thread.settledOverride !== "settled");
  const settleableThreadRefs = settleableThreads.map((thread) =>
    scopeThreadRef(thread.environmentId, thread.id),
  );
  const settleableThreadKeys = settleableThreadRefs.map((ref) => scopedThreadKey(ref));
  const canSettle = settleableThreads.length > 0 && canSettleThreads(settleableThreads);
  const isDropHighlighted = dragState.active && dragState.targetId === group.id;
  const rowId = customGroupRowId(group.id);
  const dot = group.collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;

  const startRenaming = () => {
    settledRef.current = false;
    setRenameValue(group.name);
    setIsRenaming(true);
  };

  const commitRename = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = renameValue.trim();
    if (trimmed.length > 0 && trimmed !== group.name) {
      useCustomGroupsStore.getState().renameGroup(group.id, trimmed);
    }
    setIsRenaming(false);
  };

  const cancelRename = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setRenameValue(group.name);
    setIsRenaming(false);
  };

  const handleDeleteGroup = () => {
    if (settleableThreadKeys.length === 0) {
      deleteGroupWithUndoToast(group.id, gt);
      return;
    }
    requestDeleteCustomGroup({
      groupId: group.id,
      groupName: group.name,
      settleableThreadKeys,
      settleableThreadRefs,
      canSettle,
      onSettleThreads,
      onUnsettleThreads,
    });
  };

  const openGroupContextMenu = async (
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const items = buildCustomGroupHeaderMenuItems(
      {
        collapsed: group.collapsed,
        color: group.color,
        canMoveUp,
        canMoveDown,
        canNewThread,
        settleableCount: settleableThreadKeys.length,
        canSettle,
      },
      m,
    );
    const clicked = await api.contextMenu.show(items, position, source);
    if (!clicked) return;
    const { toggleGroupCollapsed, moveGroup, setGroupColor } = useCustomGroupsStore.getState();
    switch (clicked) {
      case "new-thread":
        void onNewThreadInGroup(group.id);
        break;
      case "settle-all":
        if (canSettle) {
          onSettleThreads(settleableThreadKeys);
        }
        break;
      case "rename":
        startRenaming();
        break;
      case "toggle-collapse":
        toggleGroupCollapsed(group.id);
        break;
      case "move-up":
        moveGroup(group.id, "up");
        break;
      case "move-down":
        moveGroup(group.id, "down");
        break;
      case "delete":
        handleDeleteGroup();
        break;
      default:
        if (clicked.startsWith("color:")) {
          const nextColor = clicked.slice("color:".length) as CustomGroupColor;
          setGroupColor(group.id, nextColor);
        }
        break;
    }
  };

  return (
    <li
      data-testid="sidebar-custom-group"
      data-custom-group-id={group.id}
      data-custom-group-drop-target={group.id}
      className={cn(
        "group/custom-group relative mt-1.5 list-none rounded-(--control-radius) first:mt-0",
        isDropHighlighted && "bg-sidebar-row-hover ring-1 ring-ring",
      )}
    >
      {isRenaming ? (
        <div className="flex h-8 w-full items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset)">
          <FolderIcon className={cn("size-3.5 shrink-0", COLOR_TEXT_CLASS[group.color])} />
          <input
            type="text"
            data-testid="sidebar-custom-group-rename-input"
            aria-label={gt("Group name")}
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
            }}
            className="h-5 min-w-0 flex-1 rounded border border-ring bg-background px-1 text-xs text-foreground outline-none"
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            data-sidebar-row={rowId}
            aria-expanded={!group.collapsed}
            data-testid="sidebar-custom-group-toggle"
            onClick={() => useCustomGroupsStore.getState().toggleGroupCollapsed(group.id)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              startRenaming();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void openGroupContextMenu(
                { x: event.clientX, y: event.clientY },
                contextMenuSourceOf(event),
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                event.stopPropagation();
                startRenaming();
              }
            }}
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <FolderIcon className={cn("size-3.5 shrink-0", COLOR_TEXT_CLASS[group.color])} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
              {group.name}
            </span>
            {dot ? (
              <span className={cn("size-1.5 shrink-0 rounded-full", GROUP_DOT_CLASS_NAME[dot])}>
                <span className="sr-only">{m(GROUP_DOT_LABEL[dot])}</span>
              </span>
            ) : null}
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/custom-group:invisible group-has-[[data-sidebar-action-for]:focus]/custom-group:invisible pointer-coarse:invisible">
              {totalCount}
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
                group.collapsed && "-rotate-90",
              )}
            />
          </button>
          <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/custom-group:opacity-100 pointer-coarse:opacity-100">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("New thread in group")}
              title={gt("New thread in group")}
              data-sidebar-action-for={rowId}
              data-testid="sidebar-custom-group-new-thread"
              disabled={!canNewThread}
              onClick={(event) => {
                event.stopPropagation();
                void onNewThreadInGroup(group.id);
              }}
            >
              <PlusIcon aria-hidden />
            </Button>
          </span>
        </>
      )}
    </li>
  );
}

interface SidebarCustomGroupsSectionProps {
  groupedSections: readonly PartitionedCustomGroup<EnvironmentThreadShell>[];
  ungroupedActiveCount: number;
  canNewThread: boolean;
  canSettleThreads: (threads: readonly EnvironmentThreadShell[]) => boolean;
  onNewThreadInGroup: (groupId: string) => void | Promise<void>;
  onSettleThreads: (threadKeys: readonly string[]) => void;
  onUnsettleThreads: (threadRefs: readonly ScopedThreadRef[]) => void;
  renderThreadRow: (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    customNavigationParent?: string,
  ) => ReactNode;
}

export function SidebarCustomGroupsSection({
  groupedSections,
  ungroupedActiveCount,
  canNewThread,
  canSettleThreads,
  onNewThreadInGroup,
  onSettleThreads,
  onUnsettleThreads,
  renderThreadRow,
}: SidebarCustomGroupsSectionProps) {
  const gt = useGT();
  const dragState = useCustomGroupDragState();

  if (groupedSections.length === 0) {
    return null;
  }

  const showUngroupedZone = ungroupedActiveCount > 0 || dragState.isGroupedThread;
  const isUngroupedHighlighted =
    dragState.active && dragState.targetId === CUSTOM_GROUP_UNGROUPED_DROP_ID;

  return (
    <>
      {groupedSections.map((entry, groupIndex) => {
        const { group, threads, visibleThreads, hiddenThreads } = entry;
        const parentRowId = customGroupRowId(group.id);
        return (
          <Fragment key={group.id}>
            <SidebarCustomGroupHeader
              group={group}
              threads={threads}
              hiddenThreads={hiddenThreads}
              canMoveUp={groupIndex > 0}
              canMoveDown={groupIndex < groupedSections.length - 1}
              canNewThread={canNewThread}
              canSettleThreads={canSettleThreads}
              onNewThreadInGroup={onNewThreadInGroup}
              onSettleThreads={onSettleThreads}
              onUnsettleThreads={onUnsettleThreads}
            />
            {!group.collapsed && visibleThreads.length > 0
              ? visibleThreads.map((thread) => (
                  <Fragment key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}>
                    {renderThreadRow(thread, "active", parentRowId)}
                  </Fragment>
                ))
              : null}
            {!group.collapsed && visibleThreads.length === 0 ? (
              <li
                data-testid="sidebar-custom-group-empty"
                data-custom-group-drop-target={group.id}
                className="list-none px-7 py-1 text-2xs text-sidebar-muted-foreground/70 select-none"
              >
                {gt("Drop threads here")}
              </li>
            ) : null}
          </Fragment>
        );
      })}
      {showUngroupedZone ? (
        <li
          data-testid="sidebar-custom-group-ungrouped"
          data-custom-group-drop-target={CUSTOM_GROUP_UNGROUPED_DROP_ID}
          className={cn(
            "list-none rounded-(--control-radius) px-(--sidebar-row-content-inset) pt-2 pb-1 text-2xs font-medium text-sidebar-muted-foreground/80 select-none",
            isUngroupedHighlighted &&
              "bg-sidebar-row-hover text-sidebar-foreground ring-1 ring-ring",
          )}
        >
          {gt("Ungrouped")}
        </li>
      ) : null}
    </>
  );
}

export function SidebarCustomGroupsHost() {
  const draftGroupByDraftId = useCustomGroupsStore(
    useShallow((state) => state.draftGroupByDraftId),
  );
  const draftThreadsByThreadKey = useComposerDraftStore(
    useShallow((state) => state.draftThreadsByThreadKey),
  );
  const promotedDraftRedirects = useComposerDraftStore(
    useShallow((state) => state.promotedDraftRedirects),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep persisted custom-group membership synced when draft threads promote to server threads.
  useEffect(() => {
    const { reconcileDraftGroup } = useCustomGroupsStore.getState();
    for (const draftId of Object.keys(draftGroupByDraftId)) {
      const draft = draftThreadsByThreadKey[draftId] ?? null;
      const promotedRef = draft?.promotedTo ?? promotedDraftRedirects[draftId] ?? null;
      const currentThreadKey = draft
        ? scopedThreadKey(scopeThreadRef(draft.environmentId, draft.threadId))
        : null;
      const promotedThreadKey = promotedRef ? scopedThreadKey(promotedRef) : null;
      reconcileDraftGroup(draftId, currentThreadKey, promotedThreadKey);
    }
  }, [draftGroupByDraftId, draftThreadsByThreadKey, promotedDraftRedirects]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reset ephemeral modal and drag highlights when the sidebar host unmounts.
  useEffect(() => {
    return () => {
      endCustomGroupDrag();
      closeCreateCustomGroupModal();
      closeDeleteCustomGroupModal();
    };
  }, []);

  return (
    <>
      <CreateCustomGroupDialog />
      <DeleteCustomGroupDialog />
    </>
  );
}

const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

function routeThreadOnly(
  threads: readonly EnvironmentThreadShell[],
  routeThreadKey: string | null,
): readonly EnvironmentThreadShell[] {
  if (routeThreadKey === null) return EMPTY_THREADS;
  const routeThread = threads.find(
    (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
  );
  return routeThread === undefined ? EMPTY_THREADS : [routeThread];
}

// Separate hook isolates custom-group partitioning so React Compiler keeps Sidebar's dnd-kit refs memoized.
export function useSidebarCustomGroups<
  TFolder extends {
    readonly threads: readonly EnvironmentThreadShell[];
    readonly hiddenThreads: readonly EnvironmentThreadShell[];
  },
>(input: {
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly rawWorkingThreads: readonly EnvironmentThreadShell[];
  readonly workingShelfExpanded: boolean;
  readonly routeRowThreadKey: string | null;
  readonly rawProjectFolders: readonly TFolder[] | null;
  readonly rawOrderedThreadKeys: readonly string[];
  readonly pinnedThreads: readonly EnvironmentThreadShell[];
  readonly visibleSnoozedThreads: readonly EnvironmentThreadShell[];
  readonly renderedSettledThreads: readonly EnvironmentThreadShell[];
}) {
  const customGroups = useCustomGroupsStore(useShallow((state) => state.groups));
  const customThreadGroupByKey = useCustomGroupsStore(
    useShallow((state) => state.threadGroupByKey),
  );
  const hasCustomGroups = customGroups.length > 0;
  const customGroupPartition = partitionThreadsForCustomGroups({
    groups: customGroups,
    activeThreads: input.activeThreads,
    workingThreads: input.rawWorkingThreads,
    threadGroupByKey: customThreadGroupByKey,
    routeRowThreadKey: input.routeRowThreadKey,
  });
  const workingThreads = customGroupPartition.ungroupedWorkingThreads;
  const visibleWorkingThreads = input.workingShelfExpanded
    ? workingThreads
    : routeThreadOnly(workingThreads, input.routeRowThreadKey);
  const projectFolders = filterProjectFoldersForCustomGroups(
    input.rawProjectFolders,
    customGroupPartition.groupedThreadKeys,
  );
  const orderedThreadKeys = resolveOrderedThreadKeysWithCustomGroups({
    defaultOrderedThreadKeys: input.rawOrderedThreadKeys,
    groupedSections: customGroupPartition.groupedSections,
    pinnedThreads: input.pinnedThreads,
    ungroupedActiveThreads: customGroupPartition.ungroupedActiveThreads,
    projectFolders,
    visibleWorkingThreads,
    visibleSnoozedThreads: input.visibleSnoozedThreads,
    renderedSettledThreads: input.renderedSettledThreads,
  });
  return {
    hasCustomGroups,
    customGroupPartition,
    workingThreads,
    visibleWorkingThreads,
    projectFolders,
    orderedThreadKeys,
  };
}
