import { url } from "./base";
import { isDemoMode, mockService } from "./mock";

let registriesCache: any[] = [];

/**
 * Get registry component icon.
 * @returns {string}
 */
function getRegistryIcon(): string {
  return "mdi-database-search";
}

/**
 * Get registry provider icon (acr, ecr...).
 * @param provider
 * @param registryItem
 * @returns {string}
 */
function getRegistryProviderIcon(provider: string, registryItem?: any): string {
  if (registryItem?.configuration?.icon) {
    return registryItem.configuration.icon;
  }

  if (provider && registriesCache && registriesCache.length > 0) {
    const cached = registriesCache.find(
      (r: any) =>
        r &&
        (r.id === provider || `${r.type}.${r.name}` === provider) &&
        r.configuration?.icon
    );
    if (cached) {
      return cached.configuration.icon;
    }
  }

  let icon = "si-linuxcontainers";
  if (!provider) {
    return icon;
  }
  switch (provider.split(".")[0]) {
    case "acr":
      icon = "si-microsoftazure";
      break;
    case "custom":
      icon = "si-opencontainersinitiative";
      break;
    case "ecr":
      icon = "si-amazonaws";
      break;
    case "elastic":
      icon = "si-elastic";
      break;
    case "forgejo":
      icon = "si-forgejo";
      break;
    case "gcr":
      icon = "si-googlecloud";
      break;
    case "ghcr":
      icon = "si-github";
      break;
    case "gitea":
      icon = "si-gitea";
      break;
    case "gitlab":
      icon = "si-gitlab";
      break;
    case "dhi":
    case "hub":
      icon = "si-docker";
      break;
    case "quay":
      icon = "si-redhat";
      break;
    case "lscr":
      icon = "si-linuxserver";
      break;
    case "trueforge":
      icon = "si-linuxcontainers";
      break;
  }
  return icon;
}

/**
 * get all registries.
 * @returns {Promise<any>}
 */
async function getAllRegistries(): Promise<any> {
  if (isDemoMode()) {
    const data = await mockService.getAllRegistries();
    registriesCache = Array.isArray(data) ? data : [];
    return data;
  }
  const response = await fetch(url("api/registries"), { credentials: "include" });
  const data = await response.json();
  registriesCache = Array.isArray(data) ? data : [];
  return data;
}

/**
 * Get the hub mirror list (UI-managed + effective) and per-mirror health.
 * @returns {Promise<{ui: string[], effective: string[], health: any[]}>}
 */
async function getHubMirrors(): Promise<any> {
  if (isDemoMode()) {
    return mockService.getHubMirrors();
  }
  const response = await fetch(url("api/registries/hub/mirrors"), {
    credentials: "include",
  });
  return response.json();
}

/**
 * Replace the UI-managed hub mirror list.
 * @param mirrors
 * @returns {Promise<any>}
 */
async function setHubMirrors(mirrors: string[]): Promise<any> {
  if (isDemoMode()) {
    return mockService.setHubMirrors(mirrors);
  }
  const response = await fetch(url("api/registries/hub/mirrors"), {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mirrors }),
  });
  return response.json();
}

/**
 * Probe a single mirror URL.
 * @param url the mirror base URL to test
 * @returns {Promise<any>}
 */
async function testHubMirror(urlToTest: string): Promise<any> {
  if (isDemoMode()) {
    return mockService.testHubMirror(urlToTest);
  }
  const response = await fetch(url("api/registries/hub/mirrors/test"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: urlToTest }),
  });
  return response.json();
}

export { getRegistryIcon, getRegistryProviderIcon, getAllRegistries, getHubMirrors, setHubMirrors, testHubMirror };
