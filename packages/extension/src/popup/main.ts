import {
  DEFAULT_SETTINGS,
  type KeyIdentity,
  type KeyStatus,
  type Settings,
  send,
} from "../shared/messages.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let identity: KeyIdentity | null = null;
let status: KeyStatus | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let origin: string | null = null;

/**
 * `activeTab` — granted the moment the user opens this popup — is what makes the tab's URL
 * readable here, so the extension needs no `tabs` permission and no standing host access.
 */
async function currentOrigin(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url === undefined) return null;
  try {
    const url = new URL(tab.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function renderSite(): void {
  $("site-row").hidden = origin === null;
  if (origin === null) return;
  const host = origin.replace(/^https?:\/\//, "");
  const enabled = settings.allSites || settings.enabledOrigins.includes(origin);
  $("site-state").textContent = enabled
    ? `Enabled on ${host}.`
    : `Not enabled on ${host} — tokens here stay as ciphertext.`;
  $("enable-site").hidden = enabled;
}

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// The popup closes the moment the OS passkey prompt appears, so the ceremony runs in a tab.
$("unlock").addEventListener("click", async () => {
  await send({ type: "requestUnlock" });
  window.close();
});

$("lock").addEventListener("click", async () => {
  const reply = await send({ type: "lockNow" });
  $("status").textContent = reply.ok ? "Locked." : reply.message;
  if (reply.ok) await init();
});

$("copy-public").addEventListener("click", async () => {
  if (identity === null) return;
  await navigator.clipboard.writeText(identity.publicKey);
  $("status").textContent = "Public key copied.";
});

$("enable-site").addEventListener("click", async () => {
  if (origin === null) return;
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    $("status").textContent = "Permission declined.";
    return;
  }
  const reply = await send({
    type: "setSettings",
    patch: { enabledOrigins: [...settings.enabledOrigins, origin] },
  });
  if (!reply.ok) {
    $("status").textContent = `Could not save: ${reply.message}`;
    return;
  }
  settings = reply.data.settings;
  renderSite();
  $("status").textContent = "Enabled here. Reload the tab.";
});

async function init(): Promise<void> {
  const [state, config] = await Promise.all([
    send({ type: "getStatus" }),
    send({ type: "getSettings" }),
  ]);
  status = state.ok ? state.data.status : null;
  identity = status?.identity ?? null;
  if (!config.ok) {
    $("state").textContent = "The extension background worker is unavailable.";
    return;
  }
  settings = config.data.settings;
  origin = await currentOrigin();

  const locked = status?.locked === true;
  $("state").textContent =
    identity === null
      ? "No key yet — open settings to set up your passkey."
      : locked
        ? "Locked — unlock with your passkey to read tokens."
        : "Unlocked for this browser session.";
  $("identity").hidden = identity === null;
  $("copy-public").hidden = identity === null;
  $("unlock").hidden = identity === null || !locked;
  $("lock").hidden = identity === null || locked;
  if (identity !== null) $("fingerprint").textContent = identity.fingerprint;
  renderSite();
}

void init();
