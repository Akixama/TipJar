# X backend configuration

The X bot uses OAuth 2.0 Authorization Code Flow with PKCE. The developer app
can remain owned by the developer's existing X account: `/api/x/bot/connect`
must be opened while signed into `@TippOnSol`, and the callback rejects any
other username.

No X token or private key belongs in the repository. Configure these Vercel
environment variables for Preview and Production:

| Variable                       | Purpose                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `X_CLIENT_ID`                  | OAuth 2.0 client ID from the X app                                 |
| `X_CLIENT_SECRET`              | OAuth 2.0 confidential-client secret                               |
| `X_OAUTH_REDIRECT_URI`         | Exactly `https://tiponsol.com/api/x/callback`                      |
| `X_OAUTH_COOKIE_SECRET`        | Random secret used to sign short-lived OAuth state cookies         |
| `X_TOKEN_ENCRYPTION_KEY`       | Base64 or hex encoding of exactly 32 random bytes                  |
| `X_BOT_USERNAME`               | `TippOnSol` (without `@`)                                          |
| `DATABASE_URL`                 | Neon Postgres connection string supplied by the Vercel integration |
| `TIPONSOL_DELEGATE_PUBLIC_KEY` | Public key of the devnet-only constrained bot signer               |
| `TIPONSOL_DELEGATE_SECRET_KEY` | Encrypted Vercel secret for that generated devnet signer           |

Generate both application secrets independently and paste their output directly
into Vercel, never into a chat or committed file:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

After configuring and deploying, open
`https://tiponsol.com/api/x/bot/connect`, choose the `@TippOnSol` account on
X's consent screen, and approve the requested scopes. The callback retrieves
the immutable X user ID, checks the username, encrypts the complete token
response with AES-256-GCM, and upserts it into `x_bot_credentials`.

`GET /api/x/bot/status` reveals only connection metadata. It never returns an
access token, refresh token, ciphertext, client secret, or encryption key.

The authorization route deliberately does not use the owner-generated OAuth
1.0a access-token button in the X Developer Console. That button would create
a token for the developer's personal X account rather than `@TippOnSol`.

## Wallet-to-X linking

The devnet pilot at `/?x=setup` links an ordinary X user to a Solana wallet in
three bounded steps:

1. the server creates a single-use, ten-minute challenge containing the wallet
   address, a random nonce, the TipOnSol domain, and an explicit statement that
   no transaction or spending authority is being granted;
2. the wallet signs that exact message and the server verifies the Ed25519
   signature before consuming the challenge; and
3. the user authorizes the X app with read-only identity scopes, after which
   the immutable X user ID, username, and verified wallet address are stored.

No user OAuth token is retained. A wallet and X user ID each map to at most one
active link. Relinking atomically replaces the previous mapping.

## Devnet delegate

The pilot delegate is a separate generated Solana signer stored only in Vercel
as encrypted environment variables. It is funded solely with devnet SOL. The
public key is exposed by `/api/x/config` so a wallet can create a spending vault
whose on-chain policy names that delegate. The delegate cannot withdraw from a
vault or bypass its per-tip, daily, pause, revocation, or expiry controls.
