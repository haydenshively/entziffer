import { ALL_URLS, enabledSites, originPattern } from "../shared/origins.js";

const DYNAMIC_SCRIPT_ID = "entz-enabled-origins";

/**
 * The content script runs nowhere until an origin is enabled: this registration is the only thing
 * that injects it, and it is rebuilt from the granted host permissions alone.
 */
export async function syncDynamicScripts(): Promise<void> {
  const { allSites, origins } = await enabledSites();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  if (existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  }
  const matches = allSites ? [ALL_URLS] : origins.map(originPattern);
  if (matches.length === 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: DYNAMIC_SCRIPT_ID,
      js: ["content.js"],
      matches,
      runAt: "document_idle",
      persistAcrossSessions: false,
    },
  ]);
}
