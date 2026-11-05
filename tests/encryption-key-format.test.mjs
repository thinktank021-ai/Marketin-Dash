import assert from "node:assert/strict";
import test from "node:test";
import { decodeEncryptionKey } from "../app/encryption-key-format.ts";

test("legacy cPanel hex AES-256 key decodes to the original bytes", () => {
  const hex = "00".repeat(31) + "ff";
  const bytes = decodeEncryptionKey(hex);
  assert.equal(bytes.length, 32);
  assert.equal(bytes[0], 0);
  assert.equal(bytes[31], 255);
});

test("base64 and legacy hex keys decode to the same AES-256 key", () => {
  const hex = "0123456789abcdef".repeat(4);
  const bytes = Uint8Array.from(hex.match(/../g), item => parseInt(item, 16));
  const base64 = Buffer.from(bytes).toString("base64");
  assert.deepEqual(decodeEncryptionKey(base64), bytes);
  assert.deepEqual(decodeEncryptionKey(base64.replace(/=+$/, "")), bytes);
  assert.deepEqual(decodeEncryptionKey(hex), bytes);
});

test("malformed or short encryption keys are rejected", () => {
  for (const value of ["", "bad", "a".repeat(63), Buffer.from("short").toString("base64")]) {
    assert.throws(() => decodeEncryptionKey(value), /encryption_key_invalid_/);
  }
});
