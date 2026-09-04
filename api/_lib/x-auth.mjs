import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { neon } from "@neondatabase/serverless";

export const BOT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
];

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
  if (!body.access_token || !body.refresh_token) {
    throw new Error("X did not return both access and refresh tokens");
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

export function authorizationUrl({ state, challenge, redirectUri }) {
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: required("X_CLIENT_ID"),
    redirect_uri: redirectUri,
    scope: BOT_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

export function htmlPage(title, message, status = 200, headers = {}) {
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
    )}</h1><p>${escape(
      message
    )}</p><p><a href="/">Return to TipOnSol</a></p></main></body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
    }
  );
}
