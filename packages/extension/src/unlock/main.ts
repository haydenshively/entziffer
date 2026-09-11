import { EntzifferError } from "@entziffer/core";
import { send } from "../shared/messages.js";
import { decodeBytes, encodeBytes, getWithPrf } from "../shared/webauthn.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function say(message: string, isError = false): void {
  const state = $("state");
  state.textContent = message;
  if (isError) state.setAttribute("data-error", "");
  else state.removeAttribute("data-error");
}

function offerRetry(message: string): void {
  say(message, true);
  $("retry").hidden = false;
}

/**
 * A stored credential id that the authenticator rejects (a passkey re-synced under a new id, say)
 * falls back to the browser's own picker over discoverable credentials.
 */
async function assert(credentialId: string | null): Promise<ReturnType<typeof getWithPrf>> {
  if (credentialId === null) return getWithPrf();
  try {
    return await getWithPrf(decodeBytes(credentialId));
  } catch (e) {
    if (e instanceof EntzifferError && e.code === "PASSKEY_CANCELLED") throw e;
    return getWithPrf();
  }
}

async function unlock(): Promise<void> {
  $("retry").hidden = true;
  say("Waiting for your passkey…");
  const params = await send({ type: "getUnlockParams" });
  if (!params.ok) {
    offerRetry(params.message);
    return;
  }
  let result: Awaited<ReturnType<typeof getWithPrf>>;
  try {
    result = await assert(params.data.params.credentialId);
  } catch (e) {
    const cancelled = e instanceof EntzifferError && e.code === "PASSKEY_CANCELLED";
    offerRetry(
      cancelled ? "Cancelled. entziffer stays locked." : e instanceof Error ? e.message : String(e),
    );
    return;
  }
  const reply = await send({
    type: "unlock",
    credentialId: encodeBytes(result.credentialId),
    prf: encodeBytes(result.prf),
  });
  if (!reply.ok) {
    offerRetry(reply.message);
    return;
  }
  say("Unlocked.");
  window.close();
}

$("retry").addEventListener("click", () => void unlock());

void unlock();
