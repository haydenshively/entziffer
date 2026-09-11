export const ALL_URLS = "<all_urls>";

export interface EnabledSites {
  allSites: boolean;
  origins: string[];
}

export const originPattern = (origin: string): string => `${origin}/*`;

/**
 * The granted host permissions are the whole allowlist. Nothing mirrors them into storage, so a
 * revoke from `chrome://extensions` cannot leave a stale copy behind.
 */
export async function enabledSites(): Promise<EnabledSites> {
  const { origins = [] } = await chrome.permissions.getAll();
  return {
    allSites: origins.includes(ALL_URLS),
    origins: origins
      .filter((o) => o !== ALL_URLS)
      .map((o) => o.replace(/\/\*$/, ""))
      .sort(),
  };
}

/** `https://example.com` from anything the user might paste, or `null` when it is not an origin. */
export function toOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    const { origin, protocol } = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return protocol === "http:" || protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
}

export const requestOrigin = (origin: string): Promise<boolean> =>
  chrome.permissions.request({ origins: [originPattern(origin)] });

export const removeOrigin = (origin: string): Promise<boolean> =>
  chrome.permissions.remove({ origins: [originPattern(origin)] });
