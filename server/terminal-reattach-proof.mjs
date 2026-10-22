// Reattach is mutually authenticated without the token crossing the socket.
// The broker answers the client's nonce with a proof keyed by its current
// token before the client trusts the endpoint or sends anything spendable;
// the client then proves the same token over the broker's nonce and the
// token that replaces it. Each side's proof names its role, so one side's
// answer can never be replayed as the other's.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const NONCE = /^[A-Za-z0-9_-]{43}$/;

export function reattachNonce() { return randomBytes(32).toString("base64url"); }
export function validNonce(value) { return typeof value === "string" && NONCE.test(value); }

export function reattachProof(token, role, fields) {
  return createHmac("sha256", token).update(JSON.stringify([`outright-terminal-reattach:${role}`, ...fields])).digest("base64url");
}

export function proofMatches(expected, actual) {
  if (typeof actual !== "string" || !NONCE.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "base64url"), Buffer.from(actual, "base64url"));
}
