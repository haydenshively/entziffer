import type { Broadcast } from "../shared/messages.js";

/** Best-effort: tabs without the content script reject, and that is the common case. */
async function broadcast(message: Broadcast): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined
        ? undefined
        : chrome.tabs.sendMessage(tab.id, message).catch(() => undefined),
    ),
  );
}

export const broadcastUnlocked = (): Promise<void> => broadcast({ type: "unlocked" });

/**
 * Sent by {@link lockNow} so already-rendered plaintext disappears without a reload. Locking is
 * not complete until every tab has been told.
 */
export const broadcastLocked = (): Promise<void> => broadcast({ type: "locked" });
