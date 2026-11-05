/**
 * Accepts the historical cPanel setup-wizard format (64 hex characters)
 * and the Cloudflare-compatible base64 format for one 256-bit AES-GCM key.
 * The representation may change, but the underlying 32 bytes must not.
 */
export function decodeEncryptionKey(value: string): Uint8Array {
  const raw = value.trim();
  if (/^[a-f\d]{64}$/i.test(raw)) {
    return Uint8Array.from(raw.match(/../g) || [], pair => Number.parseInt(pair, 16));
  }
  if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{2}==$/.test(raw)) {
    throw new Error("encryption_key_invalid_format");
  }
  const bytes = Uint8Array.from(atob(raw), character => character.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("encryption_key_invalid_length");
  return bytes;
}
