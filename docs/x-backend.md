# X backend configuration

The X bot uses OAuth 2.0 Authorization Code Flow with PKCE. The developer app
can remain owned by the developer's existing X account: `/api/x/bot/connect`
must be opened while signed into `@TippOnSol`, and the callback rejects any
other username.

No X token or private key belongs in the repository. Configure these Vercel
environment variables for Preview and Production:

| Variable                 | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `X_CLIENT_ID`            | OAuth 2.0 client ID from the X app                                 |
| `X_CLIENT_SECRET`        | OAuth 2.0 confidential-client secret                               |
| `X_OAUTH_REDIRECT_URI`   | Exactly `https://tiponsol.com/api/x/callback`                      |
| `X_OAUTH_COOKIE_SECRET`  | Random secret used to sign short-lived OAuth state cookies         |
| `X_TOKEN_ENCRYPTION_KEY` | Base64 or hex encoding of exactly 32 random bytes                  |
| `X_BOT_USERNAME`         | `TippOnSol` (without `@`)                                          |
| `DATABASE_URL`           | Neon Postgres connection string supplied by the Vercel integration |

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
