/**
 * The id Chrome derives from `manifest.json`'s `"key"`, and therefore the WebAuthn RP ID of every
 * entziffer passkey. A build that loads under a different id selects a different credential and
 * derives a different X25519 key, so nothing encrypted to the old one can be read.
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/key
 */
export const EXTENSION_ID = "bgopgffcljkdlogpflimomjbfbmbaoap";
