import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { neon } from "@neondatabase/serverless";
import bs58 from "bs58";

export const BOT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
];
export const USER_LINK_SCOPES = ["tweet.read", "users.read"];

const STATE_COOKIE = "tiponsol_x_oauth";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function oauthRedirectUri(request) {
  return (
    process.env.X_OAUTH_REDIRECT_URI ??
    `${new URL(request.url).origin}/api/x/callback`
  );
}

export function createOauthState() {
  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(48));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { state, verifier, challenge };
}

export function signOauthCookie(
  payload,
  secret = required("X_OAUTH_COOKIE_SECRET")
) {
  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyOauthCookie(
  value,
  secret = required("X_OAUTH_COOKIE_SECRET")
) {
  if (!value) return null;
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );
    if (
      typeof payload.state !== "string" ||
      typeof payload.verifier !== "string" ||
      typeof payload.createdAt !== "number" ||
      payload.createdAt > Date.now() + 60_000 ||
      Date.now() - payload.createdAt > 10 * 60 * 1000
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function stateCookie(value) {
  return [
    `${STATE_COOKIE}=${value}`,
    "Path=/api/x",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=600",
  ].join("; ");
}

export function clearStateCookie() {
  return `${STATE_COOKIE}=; Path=/api/x; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readStateCookie(request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === STATE_COOKIE) return rest.join("=");
  }
  return null;
}

function encryptionKey(value = required("X_TOKEN_ENCRYPTION_KEY")) {
  const key = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("X_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function encryptTokens(tokens, keyValue) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString(
    "base64url"
  )}.${ciphertext.toString("base64url")}`;
}

export function decryptTokens(value, keyValue) {
  const [ivValue, tagValue, ciphertextValue, extra] = value.split(".");
  if (!ivValue || !tagValue || !ciphertextValue || extra) {
    throw new Error("Stored X token payload is invalid");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(keyValue),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export async function exchangeAuthorizationCode({
  code,
  verifier,
  redirectUri,
  requireRefreshToken = true,
}) {
  const clientId = required("X_CLIENT_ID");
  const clientSecret = required("X_CLIENT_SECRET");
  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${clientId}:${clientSecret}`
      ).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`X token exchange failed (${response.status})`);
  }
  if (!body.access_token || (requireRefreshToken && !body.refresh_token)) {
    throw new Error("X did not return the required OAuth tokens");
  }
  return body;
}

export async function fetchXIdentity(accessToken) {
  const response = await fetch(
    "https://api.x.com/2/users/me?user.fields=id,name,username",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const body = await response.json();
  if (!response.ok || !body.data?.id || !body.data?.username) {
    throw new Error(`X identity lookup failed (${response.status})`);
  }
  return body.data;
}

function database() {
  return neon(required("DATABASE_URL"));
}

async function ensureCredentialsTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS x_bot_credentials (
      singleton_id SMALLINT PRIMARY KEY CHECK (singleton_id = 1),
      x_user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      encrypted_tokens TEXT NOT NULL,
      scopes TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function ensureWalletLinkTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS wallet_link_challenges (
      challenge_id TEXT PRIMARY KEY,
      wallet_pubkey TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS x_wallet_links (
      x_user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      wallet_pubkey TEXT NOT NULL UNIQUE,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

function solanaPublicKeyBytes(wallet) {
  if (typeof wallet !== "string" || wallet.length < 32 || wallet.length > 44) {
    throw new Error("Invalid Solana wallet address");
  }
  let bytes;
  try {
    bytes = bs58.decode(wallet);
  } catch {
    throw new Error("Invalid Solana wallet address");
  }
  if (bytes.length !== 32) throw new Error("Invalid Solana wallet address");
  return bytes;
}

export async function createWalletLinkChallenge(wallet) {
  solanaPublicKeyBytes(wallet);
  const sql = database();
  await ensureWalletLinkTables(sql);
  const challengeId = randomBytes(24).toString("base64url");
  const message = [
    "TipOnSol wallet verification",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${challengeId}`,
    "Domain: tiponsol.com",
    "",
    "This signature does not authorize a transaction or move funds.",
  ].join("\n");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await sql`
    INSERT INTO wallet_link_challenges (
      challenge_id, wallet_pubkey, message, expires_at
    ) VALUES (${challengeId}, ${wallet}, ${message}, ${expiresAt.toISOString()})
  `;
  return { challengeId, message, expiresAt: expiresAt.toISOString() };
}

export async function verifyWalletLinkChallenge({
  challengeId,
  wallet,
  signature,
}) {
  if (
    typeof challengeId !== "string" ||
    typeof signature !== "string" ||
    signature.length > 256
  ) {
    throw new Error("Invalid wallet proof");
  }
  const sql = database();
  await ensureWalletLinkTables(sql);
  const rows = await sql`
    SELECT message
    FROM wallet_link_challenges
    WHERE challenge_id = ${challengeId}
      AND wallet_pubkey = ${wallet}
      AND used_at IS NULL
      AND expires_at > NOW()
  `;
  if (!rows[0]) throw new Error("Wallet challenge is missing or expired");
  if (!verifyWalletSignature(wallet, rows[0].message, signature)) {
    throw new Error("Wallet signature did not match");
  }

  const consumed = await sql`
    UPDATE wallet_link_challenges
    SET used_at = NOW()
    WHERE challenge_id = ${challengeId} AND used_at IS NULL
    RETURNING wallet_pubkey
  `;
  if (!consumed[0]) throw new Error("Wallet challenge was already used");
  return wallet;
}

export function verifyWalletSignature(wallet, message, signature) {
  const publicKeyBytes = solanaPublicKeyBytes(wallet);
  if (typeof message !== "string" || typeof signature !== "string")
    return false;
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;
  const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return verifySignature(
    null,
    Buffer.from(message, "utf8"),
    {
      key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(publicKeyBytes)]),
      format: "der",
      type: "spki",
    },
    signatureBytes
  );
}

export async function storeWalletLink(identity, wallet) {
  solanaPublicKeyBytes(wallet);
  const sql = database();
  await ensureWalletLinkTables(sql);
  await sql`
    WITH removed AS (
      DELETE FROM x_wallet_links
      WHERE wallet_pubkey = ${wallet} OR x_user_id = ${identity.id}
    )
    INSERT INTO x_wallet_links (
      x_user_id, username, wallet_pubkey, linked_at, updated_at
    ) VALUES (${identity.id}, ${identity.username}, ${wallet}, NOW(), NOW())
  `;
}

export async function walletLinkStatus(wallet) {
  solanaPublicKeyBytes(wallet);
  const sql = database();
  await ensureWalletLinkTables(sql);
  const rows = await sql`
    SELECT x_user_id, username, wallet_pubkey, linked_at, updated_at
    FROM x_wallet_links
    WHERE wallet_pubkey = ${wallet}
  `;
  return rows[0] ?? null;
}

export async function storeBotCredentials(identity, tokens) {
  const sql = database();
  const encryptedTokens = encryptTokens(tokens);
  await ensureCredentialsTable(sql);
  await sql`
    INSERT INTO x_bot_credentials (
      singleton_id, x_user_id, username, encrypted_tokens, scopes, updated_at
    ) VALUES (
      1, ${identity.id}, ${identity.username}, ${encryptedTokens},
      ${tokens.scope ?? BOT_SCOPES.join(" ")}, NOW()
    )
    ON CONFLICT (singleton_id) DO UPDATE SET
      x_user_id = EXCLUDED.x_user_id,
      username = EXCLUDED.username,
      encrypted_tokens = EXCLUDED.encrypted_tokens,
      scopes = EXCLUDED.scopes,
      updated_at = NOW()
  `;
}

export async function botCredentialStatus() {
  const sql = database();
  await ensureCredentialsTable(sql);
  const rows = await sql`
    SELECT x_user_id, username, scopes, updated_at
    FROM x_bot_credentials
    WHERE singleton_id = 1
  `;
  return rows[0] ?? null;
}

export function expectedBotUsername() {
  return (process.env.X_BOT_USERNAME ?? "TippOnSol").replace(/^@/, "");
}

export function authorizationUrl({
  state,
  challenge,
  redirectUri,
  scopes = BOT_SCOPES,
}) {
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: required("X_CLIENT_ID"),
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

export function htmlPage(
  title,
  message,
  status = 200,
  headers = {},
  returnPath = "/"
) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[character])
    );
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(
      title
    )}</title><style>body{margin:0;background:#0b2019;color:#f4eedf;font:16px/1.6 ui-monospace,monospace;display:grid;min-height:100vh;place-items:center}.card{max-width:620px;margin:24px;padding:36px;border:1px solid #365247;border-radius:24px;background:#123329}h1{font:700 38px/1.1 Georgia,serif;color:#efc568}a{color:#efc568}</style></head><body><main class="card"><h1>${escape(
      title
    )}</h1><p>${escape(message)}</p><p><a href="${escape(
      returnPath
    )}">Return to TipOnSol</a></p></main></body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
    }
  );
}
