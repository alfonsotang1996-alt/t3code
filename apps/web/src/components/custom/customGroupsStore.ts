import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { randomUUID } from "../../lib/utils";

export const CUSTOM_GROUPS_STORAGE_KEY = "t3code:custom:sidebar-groups:v1";

export const CUSTOM_GROUP_COLORS = [
  "default",
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "pink",
  "cyan",
] as const;

export type CustomGroupColor = (typeof CUSTOM_GROUP_COLORS)[number];

export interface CustomSidebarGroup {
  readonly id: string;
  readonly name: string;
  readonly color: CustomGroupColor;
  readonly collapsed: boolean;
  readonly createdAt: string;
}

interface DeletedCustomGroupSnapshot {
  readonly group: CustomSidebarGroup;
  readonly index: number;
  readonly threadKeys: readonly string[];
  readonly draftIds: readonly string[];
}

interface PersistedCustomGroupsState {
  groups: readonly CustomSidebarGroup[];
  threadGroupByKey: Readonly<Record<string, string>>;
  draftGroupByDraftId: Readonly<Record<string, string>>;
}

interface CustomGroupsStoreState extends PersistedCustomGroupsState {
  createGroup: (
    name: string,
    options?: {
      readonly color?: CustomGroupColor;
      readonly assignThreadKeys?: readonly string[];
    },
  ) => CustomSidebarGroup | null;
  renameGroup: (groupId: string, name: string) => boolean;
  setGroupColor: (groupId: string, color: CustomGroupColor) => void;
  toggleGroupCollapsed: (groupId: string) => void;
  setGroupCollapsed: (groupId: string, collapsed: boolean) => void;
  moveGroup: (groupId: string, direction: "up" | "down") => void;
  deleteGroup: (groupId: string) => DeletedCustomGroupSnapshot | null;
  restoreDeletedGroup: (snapshot: DeletedCustomGroupSnapshot) => void;
  assignThreadsToGroup: (threadKeys: readonly string[], groupId: string) => void;
  unassignThreads: (threadKeys: readonly string[]) => void;
  bindDraftToGroup: (draftId: string, threadKey: string, groupId: string) => void;
  reconcileDraftGroup: (
    draftId: string,
    currentThreadKey: string | null,
    promotedThreadKey: string | null,
  ) => void;
  getGroupIdForThread: (threadKey: string) => string | null;
}

const VALID_COLORS = new Set<string>(CUSTOM_GROUP_COLORS);

function normalizeGroupColor(value: unknown): CustomGroupColor {
  return typeof value === "string" && VALID_COLORS.has(value)
    ? (value as CustomGroupColor)
    : "default";
}

function normalizeStringMapping(
  value: unknown,
  validGroupIds: ReadonlySet<string>,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, groupId] of Object.entries(value)) {
    if (key.length > 0 && typeof groupId === "string" && validGroupIds.has(groupId)) {
      result[key] = groupId;
    }
  }
  return result;
}

export function normalizePersistedCustomGroupsState(
  persisted: unknown,
): PersistedCustomGroupsState {
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
    return { groups: [], threadGroupByKey: {}, draftGroupByDraftId: {} };
  }
  const candidate = persisted as {
    groups?: unknown;
    threadGroupByKey?: unknown;
    draftGroupByDraftId?: unknown;
  };
  const groups: CustomSidebarGroup[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(candidate.groups)) {
    for (const raw of candidate.groups) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Partial<CustomSidebarGroup>;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!id || !name || seenIds.has(id)) continue;
      seenIds.add(id);
      const createdAt =
        typeof entry.createdAt === "string" && entry.createdAt.trim().length > 0
          ? entry.createdAt
          : "2026-01-01T00:00:00.000Z";
      groups.push({
        id,
        name,
        color: normalizeGroupColor(entry.color),
        collapsed: entry.collapsed === true,
        createdAt,
      });
    }
  }
  return {
    groups,
    threadGroupByKey: normalizeStringMapping(candidate.threadGroupByKey, seenIds),
    draftGroupByDraftId: normalizeStringMapping(candidate.draftGroupByDraftId, seenIds),
  };
}

export const useCustomGroupsStore = create<CustomGroupsStoreState>()(
  persist(
    (set, get) => ({
      groups: [],
      threadGroupByKey: {},
      draftGroupByDraftId: {},

      createGroup: (name, options) => {
        const trimmedName = name.trim();
        if (trimmedName.length === 0) return null;
        const group: CustomSidebarGroup = {
          id: randomUUID(),
          name: trimmedName,
          color: normalizeGroupColor(options?.color),
          collapsed: false,
          createdAt: new Date().toISOString(),
        };
        set((state) => {
          const nextMappings = { ...state.threadGroupByKey };
          for (const rawKey of options?.assignThreadKeys ?? []) {
            const key = rawKey.trim();
            if (key.length > 0) nextMappings[key] = group.id;
          }
          return {
            groups: [...state.groups, group],
            threadGroupByKey: nextMappings,
          };
        });
        return group;
      },

      renameGroup: (groupId, name) => {
        const trimmedName = name.trim();
        if (trimmedName.length === 0) return false;
        let found = false;
        set((state) => {
          const index = state.groups.findIndex((group) => group.id === groupId);
          if (index < 0) return state;
          found = true;
          const existing = state.groups[index]!;
          if (existing.name === trimmedName) return state;
          const groups = [...state.groups];
          groups[index] = { ...existing, name: trimmedName };
          return { groups };
        });
        return found;
      },

      setGroupColor: (groupId, color) => {
        const normalized = normalizeGroupColor(color);
        set((state) => {
          const index = state.groups.findIndex((group) => group.id === groupId);
          if (index < 0 || state.groups[index]!.color === normalized) return state;
          const groups = [...state.groups];
          groups[index] = { ...state.groups[index]!, color: normalized };
          return { groups };
        });
      },

      toggleGroupCollapsed: (groupId) =>
        set((state) => {
          const index = state.groups.findIndex((group) => group.id === groupId);
          if (index < 0) return state;
          const groups = [...state.groups];
          groups[index] = { ...state.groups[index]!, collapsed: !state.groups[index]!.collapsed };
          return { groups };
        }),

      setGroupCollapsed: (groupId, collapsed) =>
        set((state) => {
          const index = state.groups.findIndex((group) => group.id === groupId);
          if (index < 0 || state.groups[index]!.collapsed === collapsed) return state;
          const groups = [...state.groups];
          groups[index] = { ...state.groups[index]!, collapsed };
          return { groups };
        }),

      moveGroup: (groupId, direction) =>
        set((state) => {
          const index = state.groups.findIndex((group) => group.id === groupId);
          if (index < 0) return state;
          const targetIndex = direction === "up" ? index - 1 : index + 1;
          if (targetIndex < 0 || targetIndex >= state.groups.length) return state;
          const groups = [...state.groups];
          const [moved] = groups.splice(index, 1);
          groups.splice(targetIndex, 0, moved!);
          return { groups };
        }),

      deleteGroup: (groupId) => {
        const state = get();
        const index = state.groups.findIndex((group) => group.id === groupId);
        if (index < 0) return null;
        const group = state.groups[index]!;
        const threadKeys: string[] = [];
        const nextThreadGroupByKey: Record<string, string> = {};
        for (const [key, assignedId] of Object.entries(state.threadGroupByKey)) {
          if (assignedId === groupId) threadKeys.push(key);
          else nextThreadGroupByKey[key] = assignedId;
        }
        const draftIds: string[] = [];
        const nextDraftGroupByDraftId: Record<string, string> = {};
        for (const [draftId, assignedId] of Object.entries(state.draftGroupByDraftId)) {
          if (assignedId === groupId) draftIds.push(draftId);
          else nextDraftGroupByDraftId[draftId] = assignedId;
        }
        set({
          groups: state.groups.filter((candidate) => candidate.id !== groupId),
          threadGroupByKey: nextThreadGroupByKey,
          draftGroupByDraftId: nextDraftGroupByDraftId,
        });
        return { group, index, threadKeys, draftIds };
      },

      restoreDeletedGroup: (snapshot) =>
        set((state) => {
          if (state.groups.some((candidate) => candidate.id === snapshot.group.id)) return state;
          const insertIndex = Math.max(0, Math.min(snapshot.index, state.groups.length));
          const groups = [...state.groups];
          groups.splice(insertIndex, 0, snapshot.group);
          const nextThreadGroupByKey = { ...state.threadGroupByKey };
          for (const key of snapshot.threadKeys) {
            if (nextThreadGroupByKey[key] === undefined) {
              nextThreadGroupByKey[key] = snapshot.group.id;
            }
          }
          const nextDraftGroupByDraftId = { ...state.draftGroupByDraftId };
          for (const draftId of snapshot.draftIds) {
            if (nextDraftGroupByDraftId[draftId] === undefined) {
              nextDraftGroupByDraftId[draftId] = snapshot.group.id;
            }
          }
          return {
            groups,
            threadGroupByKey: nextThreadGroupByKey,
            draftGroupByDraftId: nextDraftGroupByDraftId,
          };
        }),

      assignThreadsToGroup: (threadKeys, groupId) =>
        set((state) => {
          if (!state.groups.some((group) => group.id === groupId)) return state;
          let changed = false;
          const nextThreadGroupByKey = { ...state.threadGroupByKey };
          for (const rawKey of threadKeys) {
            const key = rawKey.trim();
            if (key.length === 0 || nextThreadGroupByKey[key] === groupId) continue;
            nextThreadGroupByKey[key] = groupId;
            changed = true;
          }
          return changed ? { threadGroupByKey: nextThreadGroupByKey } : state;
        }),

      unassignThreads: (threadKeys) =>
        set((state) => {
          let changed = false;
          const nextThreadGroupByKey = { ...state.threadGroupByKey };
          for (const key of threadKeys) {
            if (nextThreadGroupByKey[key] !== undefined) {
              delete nextThreadGroupByKey[key];
              changed = true;
            }
          }
          return changed ? { threadGroupByKey: nextThreadGroupByKey } : state;
        }),

      bindDraftToGroup: (draftId, threadKey, groupId) =>
        set((state) => {
          const groupIndex = state.groups.findIndex((group) => group.id === groupId);
          if (groupIndex < 0 || draftId.length === 0 || threadKey.length === 0) return state;
          const group = state.groups[groupIndex]!;
          const groups = group.collapsed
            ? state.groups.map((candidate, index) =>
                index === groupIndex ? { ...candidate, collapsed: false } : candidate,
              )
            : state.groups;
          return {
            groups,
            draftGroupByDraftId: { ...state.draftGroupByDraftId, [draftId]: groupId },
            threadGroupByKey: { ...state.threadGroupByKey, [threadKey]: groupId },
          };
        }),

      reconcileDraftGroup: (draftId, currentThreadKey, promotedThreadKey) =>
        set((state) => {
          const groupId = state.draftGroupByDraftId[draftId];
          if (!groupId) return state;
          const groupExists = state.groups.some((group) => group.id === groupId);
          if (!groupExists || (currentThreadKey === null && promotedThreadKey === null)) {
            const { [draftId]: _removed, ...draftGroupByDraftId } = state.draftGroupByDraftId;
            return { draftGroupByDraftId };
          }
          if (promotedThreadKey !== null) {
            const { [draftId]: _removed, ...draftGroupByDraftId } = state.draftGroupByDraftId;
            const nextThreadGroupByKey = { ...state.threadGroupByKey };
            if (
              currentThreadKey !== null &&
              currentThreadKey !== promotedThreadKey &&
              nextThreadGroupByKey[currentThreadKey] === groupId
            ) {
              delete nextThreadGroupByKey[currentThreadKey];
            }
            nextThreadGroupByKey[promotedThreadKey] = groupId;
            return {
              draftGroupByDraftId,
              threadGroupByKey: nextThreadGroupByKey,
            };
          }
          if (currentThreadKey !== null && state.threadGroupByKey[currentThreadKey] !== groupId) {
            return {
              threadGroupByKey: { ...state.threadGroupByKey, [currentThreadKey]: groupId },
            };
          }
          return state;
        }),

      getGroupIdForThread: (threadKey) => {
        const state = get();
        const groupId = state.threadGroupByKey[threadKey];
        if (!groupId) return null;
        return state.groups.some((group) => group.id === groupId) ? groupId : null;
      },
    }),
    {
      name: CUSTOM_GROUPS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        groups: state.groups,
        threadGroupByKey: state.threadGroupByKey,
        draftGroupByDraftId: state.draftGroupByDraftId,
      }),
      migrate: (persisted) => normalizePersistedCustomGroupsState(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...normalizePersistedCustomGroupsState(persisted),
      }),
    },
  ),
);
