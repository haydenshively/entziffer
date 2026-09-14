import { EntzifferError, importPublicKey } from "@entziffer/core";
import {
  type AutoLockMinutes,
  type Broadcast,
  DEFAULT_SETTINGS,
  type KeyIdentity,
  type KeyStatus,
  RESET_NOTICE_KEY,
  type Settings,
  send,
} from "../shared/messages.js";
import {
  ALL_URLS,
  type EnabledSites,
  enabledSites,
  removeOrigin,
  requestOrigin,
  toOrigin,
} from "../shared/origins.js";
import {
  fingerprintOf,
  getPeople,
  type Person,
  parseConfigRecipients,
  setPeople,
} from "../shared/people.js";
import { createWithPrf, encodeBytes, getWithPrf } from "../shared/webauthn.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings = DEFAULT_SETTINGS;
let sites: EnabledSites = { allSites: false, origins: [] };
let status: KeyStatus | null = null;
let people: Person[] = [];
let fingerprints = new Map<string, string>();

const identity = (): KeyIdentity | null => status?.identity ?? null;

function say(message: string, isError = false): void {
  const line = $("status");
  line.textContent = message;
  if (isError) line.setAttribute("data-error", "");
  else line.removeAttribute("data-error");
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
  const key = identity();
  const locked = status?.locked === true;
  document.body.dataset.state = key === null ? "none" : locked ? "locked" : "unlocked";
  show("onboarding", key === null);
  show("identity", key !== null);
  $("danger-fpr").textContent = key?.fingerprint ?? "—";
  if (key === null) return;
  $("fingerprint").textContent = key.fingerprint;
  $("public-key").textContent = key.publicKey;
  $("cli-snippet").textContent = `npx entziffer keys add me ${key.publicKey}`;
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
  await chrome.storage.local.remove(RESET_NOTICE_KEY);
  show("reset-notice", false);
  renderIdentity();
  say(`Ready. Your public key is ${identity()?.fingerprint ?? ""}.`);
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
    remove.className = "glass-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => onRemove(origin));
    li.append(label, remove);
    list.appendChild(li);
  }
}

function renderSites(): void {
  ($("all-sites") as HTMLInputElement).checked = sites.allSites;
  renderOriginList("enabled-list", sites.origins, (origin) => {
    void disableOrigin(origin);
  });
}

function renderPeople(): void {
  const list = $("people-list");
  list.textContent = "";
  if (people.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No one yet";
    list.appendChild(li);
    return;
  }
  for (const person of people) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    const name = document.createElement("span");
    name.textContent = person.name;
    const fpr = document.createElement("code");
    fpr.className = "pill mono";
    fpr.textContent = fingerprints.get(person.publicKey) ?? "…";
    who.append(name, fpr);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "glass-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => void forgetPerson(person));
    li.append(who, remove);
    list.appendChild(li);
  }
}

async function refreshPeople(): Promise<void> {
  people = await getPeople();
  fingerprints = new Map(
    await Promise.all(
      people.map(async (p) => [p.publicKey, await fingerprintOf(p.publicKey)] as const),
    ),
  );
  renderPeople();
}

async function forgetPerson(person: Person): Promise<void> {
  await setPeople(people.filter((p) => p.publicKey !== person.publicKey));
  await refreshPeople();
  say("Saved.");
}

/**
 * The key field doubles as an importer: a pasted CLI `config.json` adds every recipient it names
 * that is not already here, which is what keeps the two address books agreeing.
 */
async function addPerson(): Promise<void> {
  const nameField = $("person-name") as HTMLInputElement;
  const keyField = $("person-key") as HTMLInputElement;
  const known = (key: string): boolean => people.some((p) => p.publicKey === key);
  const imported = parseConfigRecipients(keyField.value);
  if (imported !== null) {
    const fresh = imported.filter((p) => !known(p.publicKey));
    if (fresh.length === 0) {
      say("That config names no one new.", true);
      return;
    }
    await setPeople([...people, ...fresh]);
    keyField.value = "";
    await refreshPeople();
    say(`Imported ${fresh.length} from your CLI config.`);
    return;
  }
  const name = nameField.value.trim();
  const key = keyField.value.trim();
  if (name === "") {
    say("Give the key a name first.", true);
    return;
  }
  try {
    await importPublicKey(key);
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), true);
    return;
  }
  if (known(key)) {
    say("That key is already here.", true);
    return;
  }
  await setPeople([...people, { name, publicKey: key }]);
  nameField.value = "";
  keyField.value = "";
  await refreshPeople();
  say(`Saved ${name}.`);
}

function renderSettings(): void {
  ($("auto-lock") as HTMLSelectElement).value = String(settings.autoLockMinutes);
}

async function refreshSites(): Promise<void> {
  sites = await enabledSites();
  renderSites();
}

async function disableOrigin(origin: string): Promise<void> {
  await removeOrigin(origin);
  await refreshSites();
  say("Saved.");
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
    refreshSites(),
    refreshPeople(),
  ]);
  status = state.ok ? state.data.status : null;
  if (config.ok) settings = config.data.settings;
  else say(`Settings unavailable: ${config.message}. Showing defaults.`, true);
  show("reset-notice", stored[RESET_NOTICE_KEY] === true && identity() === null);
  renderIdentity();
  renderSettings();
}

$("setup").addEventListener("click", () => void setUp(true));
$("recover").addEventListener("click", () => void setUp(false));

$("copy-public").addEventListener("click", (e) => {
  const key = identity();
  if (key !== null) void copy(key.publicKey, e.currentTarget as HTMLButtonElement);
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
    await refreshSites();
    say("Saved.");
    return;
  }
  const granted = await chrome.permissions.request({ origins: [ALL_URLS] });
  await refreshSites();
  say(granted ? "entziffer is now enabled everywhere." : "Permission declined.", !granted);
});

$("add-origin").addEventListener("click", async () => {
  const field = $("add-origin-input") as HTMLInputElement;
  const origin = toOrigin(field.value);
  if (origin === null) {
    say("Enter an http(s) origin, e.g. https://linear.app", true);
    return;
  }
  if (!(await requestOrigin(origin))) {
    say("Permission declined.", true);
    return;
  }
  field.value = "";
  await refreshSites();
  say("Saved.");
});

$("add-person").addEventListener("click", () => void addPerson());

$("auto-lock").addEventListener("change", (event) => {
  const minutes = Number((event.target as HTMLSelectElement).value) as AutoLockMinutes;
  void patch({ autoLockMinutes: minutes });
});

$("forget").addEventListener("click", async () => {
  const key = identity();
  if (key === null) return;
  if (($("forget-confirm") as HTMLInputElement).value.trim() !== key.fingerprint) {
    say("Type the fingerprint exactly to confirm.", true);
    return;
  }
  const reply = await send({ type: "forgetKey" });
  if (!reply.ok) {
    say(reply.message, true);
    return;
  }
  status = null;
  ($("forget-confirm") as HTMLInputElement).value = "";
  renderIdentity();
  say("Key forgotten here. The passkey still exists; setting up with it returns the same key.");
});

chrome.runtime.onMessage.addListener((message: Broadcast) => {
  if (message.type === "people") void refreshPeople();
  else void refresh();
});

chrome.permissions.onAdded.addListener(() => void refreshSites());
chrome.permissions.onRemoved.addListener(() => void refreshSites());

void refresh();
