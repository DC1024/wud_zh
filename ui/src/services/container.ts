import { url } from "./base";
import { isDemoMode, mockService } from "./mock";

/**
 * Lightweight container description returned by the discovery endpoint.
 * It covers containers that are NOT watched, which the regular container API
 * cannot return because it only knows about monitored containers.
 */
export interface DiscoveredContainer {
  watcher: string;
  name: string;
  id: string;
  image: string;
  state: string;
  stack?: string;
  watched: boolean;
  /**
   * Which input decided the watch state:
   *  - label      : an explicit `wud.watch` label, always wins
   *  - preference : a choice made from this UI
   *  - default    : the watcher `watchbydefault` setting
   */
  watchedBy: "label" | "preference" | "default";
}

/**
 * A stored preference whose container no longer exists, typically because it
 * has been removed or renamed.
 */
export interface OrphanWatchPreference {
  watcher: string;
  name: string;
  watched: boolean;
}

export interface OrphanWatchPreferenceReport {
  orphans: OrphanWatchPreference[];
  /**
   * Watchers that could not be enumerated (daemon unreachable, discovery
   * unsupported). Their preferences are never reported as orphans, so the
   * cleanup can never wipe them by mistake.
   */
  failedWatchers: string[];
}

function getContainerIcon() {
  return "mdi-docker";
}

async function getAllContainers() {
  if (isDemoMode()) {
    return mockService.getAllContainers();
  }
  const response = await fetch(url("api/containers"), { credentials: "include" });
  return response.json();
}

async function refreshAllContainers() {
  if (isDemoMode()) {
    return mockService.refreshAllContainers();
  }
  const response = await fetch(url("api/containers/watch?async=true"), {
    method: "POST",
    credentials: "include",
  });
  return response.json();
}

async function refreshContainer(containerId) {
  if (isDemoMode()) {
    return mockService.refreshContainer(containerId);
  }
  const response = await fetch(url(`api/containers/${containerId}/watch`), {
    method: "POST",
    credentials: "include",
  });
  if (response.status === 404) {
    return undefined;
  }
  return response.json();
}

async function deleteContainer(containerId) {
  if (isDemoMode()) {
    return mockService.deleteContainer(containerId);
  }
  return fetch(url(`api/containers/${containerId}`), { method: "DELETE", credentials: "include" });
}

async function getContainerTriggers(containerId) {
  if (isDemoMode()) {
    return mockService.getContainerTriggers(containerId);
  }
  const response = await fetch(url(`api/containers/${containerId}/triggers`), { credentials: "include" });
  return response.json();
}

async function runTrigger({
  containerId,
  triggerType,
  triggerName,
  overrideCooldown,
}: {
  containerId: string;
  triggerType: string;
  triggerName: string;
  overrideCooldown?: boolean;
}) {
  if (isDemoMode()) {
    return mockService.runContainerTrigger({ containerId, triggerType, triggerName, overrideCooldown });
  }
  const query = overrideCooldown ? "?overrideCooldown=true" : "";
  const response = await fetch(
    url(`api/containers/${containerId}/triggers/${triggerType}/${triggerName}${query}`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: overrideCooldown !== undefined ? JSON.stringify({ overrideCooldown }) : undefined,
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || response.statusText);
  }
  return response.json();
}

/**
 * List every container known to the watchers, watched or not.
 * @returns {Promise<DiscoveredContainer[]>}
 */
async function discoverContainers(): Promise<DiscoveredContainer[]> {
  if (isDemoMode()) {
    return mockService.discoverContainers();
  }
  const response = await fetch(url("api/containers/discover"), {
    credentials: "include",
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || response.statusText);
  }
  const body = await response.json();
  return body.containers || [];
}

/**
 * Set (or clear) the watch preference of a container.
 * @param watcher watcher name
 * @param name container name (not the id, which changes on recreation)
 * @param watched true to watch, false to skip, null to clear the preference
 */
async function setWatchPreference({
  watcher,
  name,
  watched,
}: {
  watcher: string;
  name: string;
  watched: boolean | null;
}) {
  if (isDemoMode()) {
    return mockService.setWatchPreference({ watcher, name, watched });
  }
  const response = await fetch(url("api/containers/watch-preference"), {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ watcher, name, watched }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || response.statusText);
  }
  return response.json();
}

/**
 * List the watch preferences pointing to containers that no longer exist.
 * Detection only: nothing is deleted.
 */
async function listOrphanWatchPreferences(): Promise<OrphanWatchPreferenceReport> {
  if (isDemoMode()) {
    return mockService.listOrphanWatchPreferences();
  }
  const response = await fetch(url("api/containers/watch-preference/orphans"), {
    credentials: "include",
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || response.statusText);
  }
  const body = await response.json();
  return {
    orphans: body.orphans || [],
    failedWatchers: body.failedWatchers || [],
  };
}

/**
 * Delete every orphan watch preference.
 * @returns the number of preferences actually removed
 */
async function purgeOrphanWatchPreferences(): Promise<{
  removed: { watcher: string; name: string }[];
  count: number;
  failedWatchers: string[];
}> {
  if (isDemoMode()) {
    return mockService.purgeOrphanWatchPreferences();
  }
  const response = await fetch(url("api/containers/watch-preference/orphans"), {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || response.statusText);
  }
  const body = await response.json();
  return {
    removed: body.removed || [],
    count: typeof body.count === "number" ? body.count : (body.removed || []).length,
    failedWatchers: body.failedWatchers || [],
  };
}

async function snoozeContainer(
  containerId: string,
  { version, until }: { version?: string; until?: number } = {},
) {
  if (isDemoMode()) {
    return mockService.snoozeContainer(containerId, { version, until });
  }
  const response = await fetch(url(`api/containers/${containerId}/snooze`), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version, until }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || response.statusText);
  }
  return response.json();
}

async function unsnoozeContainer(containerId: string) {
  if (isDemoMode()) {
    return mockService.unsnoozeContainer(containerId);
  }
  const response = await fetch(url(`api/containers/${containerId}/snooze`), {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || response.statusText);
  }
  return response.json();
}

export {
  getContainerIcon,
  getAllContainers,
  discoverContainers,
  setWatchPreference,
  listOrphanWatchPreferences,
  purgeOrphanWatchPreferences,
  refreshAllContainers,
  refreshContainer,
  deleteContainer,
  snoozeContainer,
  unsnoozeContainer,
  getContainerTriggers,
  runTrigger,
};
