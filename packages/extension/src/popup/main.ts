import { type Broadcast, type KeyIdentity, type KeyStatus, send } from "../shared/messages.js";
import { type EnabledSites, enabledSites, requestOrigin, toOrigin } from "../shared/origins.js";
import { getPeople } from "../shared/people.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function say(message: string, isError = false): void {
  const line = $("status");
  line.textContent = message;
  if (isError) line.setAttribute("data-error", "");
  else line.removeAttribute("data-error");
}

let status: KeyStatus | null = null;
let sites: EnabledSites = { allSites: false, origins: [] };
let origin: string | null = null;

const identity = (): KeyIdentity | null => status?.identity ?? null;

/**
 * `activeTab` — granted the moment the user opens this popup — is what makes the tab's URL
 * readable here, so the extension needs no `tabs` permission and no standing host access.
 */
async function currentOrigin(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url === undefined ? null : toOrigin(tab.url);
}

function renderSite(): void {
  $("site-row").hidden = origin === null;
  if (origin === null) return;
  const host = origin.replace(/^https?:\/\//, "");
  const enabled = sites.allSites || sites.origins.includes(origin);
  $("site-state").textContent = enabled
    ? `Enabled on ${host}.`
    : `Not enabled on ${host} — tokens here stay as ciphertext.`;
  $("enable-site").hidden = enabled;
}

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// `openOptionsPage` takes no fragment, so the People section is reached by opening the page itself.
$("people").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("options/index.html#people") });
  window.close();
});

// The popup closes the moment the OS passkey prompt appears, so the ceremony runs in its own window.
$("unlock").addEventListener("click", async () => {
  await send({ type: "requestUnlock" });
  window.close();
});

$("lock").addEventListener("click", async () => {
  const reply = await send({ type: "lockNow" });
  say(reply.ok ? "Locked." : reply.message, !reply.ok);
  if (reply.ok) await init();
});

$("copy-public").addEventListener("click", async () => {
  const key = identity();
  if (key === null) return;
  await navigator.clipboard.writeText(key.publicKey);
  say("Public key copied.");
});

$("enable-site").addEventListener("click", async () => {
  if (origin === null) return;
  if (!(await requestOrigin(origin))) {
    say("Permission declined.", true);
    return;
  }
  sites = await enabledSites();
  renderSite();
  say("Enabled here. Reload the tab.");
});

async function init(): Promise<void> {
  const [state, enabled, current, people] = await Promise.all([
    send({ type: "getStatus" }),
    enabledSites(),
    currentOrigin(),
    getPeople().catch(() => []),
  ]);
  $("people").textContent = `People · ${people.length}`;
  if (!state.ok) {
    $("state").textContent = "The extension background worker is unavailable.";
    return;
  }
  status = state.data.status;
  sites = enabled;
  origin = current;

  const key = identity();
  const locked = status.locked;
  document.body.dataset.state = key === null ? "none" : locked ? "locked" : "unlocked";
  $("state").textContent =
    key === null
      ? "No key yet — open settings to set up your passkey."
      : locked
        ? "Locked — unlock with your passkey to read tokens."
        : "Unlocked for this browser session.";
  $("identity").hidden = key === null;
  $("copy-public").hidden = key === null;
  $("unlock").hidden = key === null || !locked;
  $("lock").hidden = key === null || locked;
  if (key !== null) $("fingerprint").textContent = key.fingerprint;
  renderSite();
}

chrome.runtime.onMessage.addListener((message: Broadcast) => {
  if (message.type === "locked" || message.type === "unlocked") void init();
});

void init();
