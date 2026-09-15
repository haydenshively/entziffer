import { describe, expect, it } from "vitest";
import { CONTENT_TYPES, isPrivileged, type RequestType } from "../src/shared/messages.js";

/** Fails to compile when a request type is added without deciding whether content may send it. */
const ALL_TYPES: Record<RequestType, true> = {
  getStatus: true,
  getUnlockParams: true,
  requestUnlock: true,
  setupKey: true,
  unlock: true,
  lockNow: true,
  decrypt: true,
  getSettings: true,
  setSettings: true,
  forgetKey: true,
};

describe("isPrivileged", () => {
  it("privileges every type outside the content allowlist", () => {
    const privileged = Object.keys(ALL_TYPES).filter((type) => isPrivileged(type as RequestType));
    expect(privileged.sort()).toEqual(
      Object.keys(ALL_TYPES)
        .filter((type) => !(CONTENT_TYPES as readonly string[]).includes(type))
        .sort(),
    );
    expect(privileged).not.toHaveLength(0);
  });

  it("lets a content script send only decrypt and requestUnlock", () => {
    expect(CONTENT_TYPES.filter(isPrivileged)).toEqual([]);
    expect([...CONTENT_TYPES].sort()).toEqual(["decrypt", "requestUnlock"]);
  });
});
