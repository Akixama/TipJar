import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import bs58 from "bs58";
import {
  authorizationUrl,
  BOT_SCOPES,
  createOauthState,
  decryptTokens,
  encryptTokens,
  signOauthCookie,
  verifyOauthCookie,
  verifyWalletSignature,
} from "../api/_lib/x-auth.mjs";

test("creates a PKCE verifier and S256 challenge", () => {
  const state = createOauthState();
  assert.ok(state.state.length >= 32);
  assert.ok(state.verifier.length >= 43);
  assert.ok(state.challenge.length >= 43);
});

test("signs and verifies OAuth state without exposing the cookie secret", () => {
  const payload = {
    state: "state",
    verifier: "verifier",
    createdAt: Date.now(),
  };
  const cookie = signOauthCookie(payload, "test-cookie-secret");
  assert.deepEqual(verifyOauthCookie(cookie, "test-cookie-secret"), payload);
  assert.equal(
    verifyOauthCookie(`${cookie}tampered`, "test-cookie-secret"),
    null
  );
});

test("encrypts stored bot tokens with authenticated encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const tokens = {
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 7200,
  };
  const encrypted = encryptTokens(tokens, key);
  assert.ok(!encrypted.includes("access"));
  assert.deepEqual(decryptTokens(encrypted, key), tokens);
  assert.throws(() => decryptTokens(`${encrypted}broken`, key));
});

test("requests only the bot OAuth scopes and exact callback", () => {
  const previousClientId = process.env.X_CLIENT_ID;
  process.env.X_CLIENT_ID = "client-id";
  try {
    const url = authorizationUrl({
      state: "state",
      challenge: "challenge",
      redirectUri: "https://tiponsol.com/api/x/callback",
    });
    assert.equal(url.searchParams.get("scope"), BOT_SCOPES.join(" "));
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://tiponsol.com/api/x/callback"
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  } finally {
    if (previousClientId === undefined) delete process.env.X_CLIENT_ID;
    else process.env.X_CLIENT_ID = previousClientId;
  }
});

test("verifies a Solana-compatible Ed25519 wallet signature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const wallet = bs58.encode(publicDer.subarray(publicDer.length - 32));
  const message = "TipOnSol wallet verification";
  const signature = sign(null, Buffer.from(message), privateKey).toString(
    "base64"
  );
  assert.equal(verifyWalletSignature(wallet, message, signature), true);
  assert.equal(verifyWalletSignature(wallet, `${message}!`, signature), false);
});
