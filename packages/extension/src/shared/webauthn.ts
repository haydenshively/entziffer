import { b64urlDecode, b64urlEncode, EntzifferError, FIXED_PRF_SALT } from "@entziffer/core";

/**
 * Omitted so the browser uses the extension's own origin as the RP ID, which keeps the credential
 * bound to the pinned extension id in `identity.ts`. Changing it changes every derived key,
 * because the passkey it selects changes.
 * @see https://developer.chrome.com/docs/extensions/how-to/integrate/passkeys
 */
export const RP_ID: string | undefined = undefined;
export const RP_NAME = "entziffer";

/** The one salt every entziffer ceremony evaluates; see `@entziffer/core`'s `derive.ts`. */
export const PRF_SALT: Uint8Array = FIXED_PRF_SALT;

const CHALLENGE_BYTES = 32;

interface PrfInputs {
  prf?: { eval?: { first: BufferSource } };
}

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

/**
 * The ceremony is local: nothing verifies the signature, so the challenge only has to be fresh.
 * The security property comes from the authenticator's PRF output, not from attestation.
 */
function challenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
}

export const encodeBytes = (bytes: Uint8Array): string => b64urlEncode(bytes);
export const decodeBytes = (s: string): Uint8Array => b64urlDecode(s);

function prfOutput(credential: PublicKeyCredential): Uint8Array | undefined {
  const results = credential.getClientExtensionResults() as PrfResults;
  const first = results.prf?.results?.first;
  return first === undefined ? undefined : new Uint8Array(first);
}

function requirePrf(prf: Uint8Array | undefined): Uint8Array {
  if (prf === undefined) {
    throw new EntzifferError(
      "PRF_UNSUPPORTED",
      "this passkey provider did not return a PRF value; macOS 15+ with iCloud Keychain (or another PRF-capable provider) is required",
    );
  }
  return prf;
}

/** Maps a user cancellation to `PASSKEY_CANCELLED` so callers can stay silent about it. */
function rethrow(e: unknown): never {
  if (e instanceof EntzifferError) throw e;
  if (e instanceof DOMException && e.name === "NotAllowedError") {
    throw new EntzifferError("PASSKEY_CANCELLED", "the passkey prompt was dismissed");
  }
  throw e;
}

export interface PasskeyResult {
  credentialId: Uint8Array;
  prf: Uint8Array;
}

/**
 * Creates a discoverable credential and returns its PRF output, falling back to an immediate
 * assertion when the provider withholds PRF at creation time.
 * @throws EntzifferError `PRF_UNSUPPORTED` if neither ceremony yields PRF; nothing is stored.
 */
export async function createWithPrf(label: string): Promise<PasskeyResult> {
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { name: RP_NAME, ...(RP_ID === undefined ? {} : { id: RP_ID }) },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)) as BufferSource,
          name: label,
          displayName: label,
        },
        challenge: challenge() as BufferSource,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: { eval: { first: PRF_SALT as BufferSource } } } as PrfInputs,
      },
    })) as PublicKeyCredential | null;
    if (credential === null) {
      throw new EntzifferError("PASSKEY_CANCELLED", "no passkey was created");
    }
    const credentialId = new Uint8Array(credential.rawId);
    const atCreate = prfOutput(credential);
    if (atCreate !== undefined) return { credentialId, prf: atCreate };
    return getWithPrf(credentialId);
  } catch (e) {
    return rethrow(e);
  }
}

/**
 * Runs the assertion that produces the PRF bytes the key is derived from. Without a
 * `credentialId` the browser shows its own picker over discoverable credentials, which is how a
 * second Mac finds the passkey synced through iCloud Keychain.
 */
export async function getWithPrf(credentialId?: Uint8Array): Promise<PasskeyResult> {
  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: challenge() as BufferSource,
        allowCredentials:
          credentialId === undefined
            ? []
            : [{ type: "public-key", id: credentialId as BufferSource }],
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_SALT as BufferSource } } } as PrfInputs,
      },
    })) as PublicKeyCredential | null;
    if (credential === null) {
      throw new EntzifferError("PASSKEY_CANCELLED", "no passkey was used");
    }
    return {
      credentialId: new Uint8Array(credential.rawId),
      prf: requirePrf(prfOutput(credential)),
    };
  } catch (e) {
    return rethrow(e);
  }
}
