import { formatFingerprint, parseEnvelope } from "@entziffer/core";
import type { TokenResult } from "../shared/messages.js";
import { namesByFingerprint } from "../shared/people.js";

const isForeign = (result: TokenResult): boolean => !result.ok && result.code === "FPR_MISMATCH";

function fingerprintOfToken(token: string | undefined): string | null {
  if (token === undefined) return null;
  try {
    return formatFingerprint(parseEnvelope(token).fpr);
  } catch {
    return null;
  }
}

/**
 * Names the recipient of every token this key could not open, so the card can say whose a foreign
 * token is. The address book is read once per batch, and not at all for a page of readable tokens.
 */
export async function withRecipients(
  results: TokenResult[],
  tokens: string[],
): Promise<TokenResult[]> {
  if (!results.some(isForeign)) return results;
  const names = await namesByFingerprint();
  return results.map((result, i) => {
    if (result.ok || !isForeign(result)) return result;
    const fpr = fingerprintOfToken(tokens[i]);
    const name = fpr === null ? undefined : names.get(fpr);
    return name === undefined ? result : { ...result, recipient: name };
  });
}
