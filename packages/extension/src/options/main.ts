import { EntzifferError } from "@entziffer/core";
import {
  type AutoLockMinutes,
  DEFAULT_SETTINGS,
  type KeyIdentity,
  type KeyStatus,
  type Settings,
  send,
} from "../shared/messages.js";
import { createWithPrf, encodeBytes, getWithPrf } from "../shared/webauthn.js";

const RESET_NOTICE_KEY = "keyStorageReset";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let identity: KeyIdentity | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let status: KeyStatus | null = null;

function say(message: string, isError = false): void {
  const status = $("status");
  status.textContent = message;
  if (isError) status.setAttribute("data-error", "");
  else status.removeAttribute("data-error");
}

function show(id: string, visible: boolean): void {
  $(id).hidden = !visible;
}

async function copy(text: string, button: HTMLButtonElement): Promise<void> {
  await navigator.clipboard.writeText(text);
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = label;
  }, 900);
}

function renderIdentity(): void {
  show("onboarding", identity === null);
  show("identity", identity !== null);
  $("danger-fpr").textContent = identity?.fingerprint ?? "—";
  if (identity === null) return;
  $("fingerprint").textContent = identity.fingerprint;
  $("public-key").textContent = identity.publicKey;
  $("cli-snippet").textContent = `npx entziffer keys add me ${identity.publicKey}`;
  const locked = status?.locked === true;
  $("key-state").textContent = locked
    ? "Locked. The next token you open will ask for your passkey."
    : "Unlocked for this browser session.";
  show("unlock", locked);
  show("lock", !locked);
}

function passkeyMessage(e: unknown): string {
  if (e instanceof EntzifferError && e.code === "PASSKEY_CANCELLED") {
    return "Cancelled. Nothing changed.";
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Both entry points end in the same `setupKey`: creating a passkey and finding an existing one
 * differ only in the ceremony that produces the PRF output.
 */
async function setUp(create: boolean): Promise<void> {
  say("Follow the passkey prompt…");
  let result: Awaited<ReturnType<typeof getWithPrf>>;
  try {
    result = create ? await createWithPrf("entziffer") : await getWithPrf();
  } catch (e) {
    say(passkeyMessage(e), true);
    return;
  }
  const reply = await send({
    type: "setupKey",
    credentialId: encodeBytes(result.credentialId),
    prf: encodeBytes(result.prf),
  });
  if (!reply.ok) {
    say(reply.message, true);
    return;
  }
  status = reply.data.status;
  identity = status.identity;
  await chrome.storage.local.remove(RESET_NOTICE_KEY);
  show("reset-notice", false);
  renderIdentity();
  say(`Ready. Your public key is ${identity?.fingerprint ?? ""}.`);
}

const ALL_URLS = "<all_urls>";

/** `https://example.com` from anything the user might paste, or `null` when it is not an origin. */
function toOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    const { origin, protocol } = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return protocol === "http:" || protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
}

function renderOriginList(id: string, origins: string[], onRemove: (o: string) => void): void {
  const list = $(id);
  list.textContent = "";
  if (origins.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None";
    list.appendChild(li);
    return;
  }
  for (const origin of origins) {
    const li = document.createElement("li");
    const label = document.createElement("code");
    label.textContent = origin;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => onRemove(origin));
    li.append(label, remove);
    list.appendChild(li);
  }
}

function renderSettings(): void {
  ($("overlay-only") as HTMLInputElement).checked = settings.overlayOnly;
  ($("all-sites") as HTMLInputElement).checked = settings.allSites;
  renderOriginList("enabled-list", settings.enabledOrigins, (origin) => {
    void disableOrigin(origin);
  });
  ($("auto-lock") as HTMLSelectElement).value = String(settings.autoLockMinutes);
}

/** Drops the origin and hands its host permission back, so the allowlist is the whole story. */
async function disableOrigin(origin: string): Promise<void> {
  await chrome.permissions.remove({ origins: [`${origin}/*`] });
  await patch({ enabledOrigins: settings.enabledOrigins.filter((o) => o !== origin) });
}

async function patch(next: Partial<Settings>): Promise<void> {
  const reply = await send({ type: "setSettings", patch: next });
  if (!reply.ok) {
    say(reply.message, true);
    return;
  }
  settings = reply.data.settings;
  renderSettings();
  say("Saved.");
}

async function refresh(): Promise<void> {
  const [state, config, stored] = await Promise.all([
    send({ type: "getStatus" }),
    send({ type: "getSettings" }),
    chrome.storage.local.get(RESET_NOTICE_KEY),
  ]);
  status = state.ok ? state.data.status : null;
  identity = status?.identity ?? null;
  if (config.ok) settings = config.data.settings;
  else say(`Settings unavailable: ${config.message}. Showing defaults.`, true);
  show("reset-notice", stored[RESET_NOTICE_KEY] === true && identity === null);
  renderIdentity();
  renderSettings();
}

$("setup").addEventListener("click", () => void setUp(true));
$("recover").addEventListener("click", () => void setUp(false));

$("copy-public").addEventListener("click", (e) => {
  if (identity !== null) void copy(identity.publicKey, e.currentTarget as HTMLButtonElement);
});

$("copy-cli").addEventListener("click", (e) => {
  void copy($("cli-snippet").textContent ?? "", e.currentTarget as HTMLButtonElement);
});

$("unlock").addEventListener("click", async () => {
  await send({ type: "requestUnlock" });
});

$("lock").addEventListener("click", async () => {
  const reply = await send({ type: "lockNow" });
  if (!reply.ok) {
    say(reply.message, true);
    return;
  }
  await refresh();
  say("Locked. The next token you open will ask for your passkey.");
});

$("all-sites").addEventListener("change", async (event) => {
  const wanted = (event.target as HTMLInputElement).checked;
  if (!wanted) {
    await chrome.permissions.remove({ origins: [ALL_URLS] });
    await patch({ allSites: false });
    return;
  }
  const granted = await chrome.permissions.request({ origins: [ALL_URLS] });
  if (!granted) {
    ($("all-sites") as HTMLInputElement).checked = false;
    say("Permission declined.", true);
    return;
  }
  await patch({ allSites: true });
  say("entziffer is now enabled everywhere.");
});

$("add-origin").addEventListener("click", async () => {
  const field = $("add-origin-input") as HTMLInputElement;
  const origin = toOrigin(field.value);
  if (origin === null) {
    say("Enter an http(s) origin, e.g. https://linear.app", true);
    return;
  }
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    say("Permission declined.", true);
    return;
  }
  field.value = "";
  await patch({ enabledOrigins: [...settings.enabledOrigins, origin] });
});

$("overlay-only").addEventListener("change", (event) => {
  void patch({ overlayOnly: (event.target as HTMLInputElement).checked });
});

$("auto-lock").addEventListener("change", (event) => {
  const minutes = Number((event.target as HTMLSelectElement).value) as AutoLockMinutes;
  void patch({ autoLockMinutes: minutes });
});

$("forget").addEventListener("click", async () => {
  if (identity === null) return;
  if (($("forget-confirm") as HTMLInputElement).value.trim() !== identity.fingerprint) {
    say("Type the fingerprint exactly to confirm.", true);
    return;
  }
  const reply = await send({ type: "forgetKey" });
  if (!reply.ok) {
    say(reply.message, true);
    return;
  }
  identity = null;
  status = null;
  ($("forget-confirm") as HTMLInputElement).value = "";
  renderIdentity();
  say("Key forgotten here. The passkey still exists; setting up with it returns the same key.");
});

void refresh();
