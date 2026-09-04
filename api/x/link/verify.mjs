import {
  authorizationUrl,
  createOauthState,
  oauthRedirectUri,
  signOauthCookie,
  stateCookie,
  USER_LINK_SCOPES,
  verifyWalletLinkChallenge,
} from "../../_lib/x-auth.mjs";

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    try {
      const proof = await request.json();
      const wallet = await verifyWalletLinkChallenge(proof);
      const oauth = createOauthState();
      const redirectUri = oauthRedirectUri(request);
      const location = authorizationUrl({
        state: oauth.state,
        challenge: oauth.challenge,
        redirectUri,
        scopes: USER_LINK_SCOPES,
      });
      const cookie = signOauthCookie({
        purpose: "link",
        wallet,
        state: oauth.state,
        verifier: oauth.verifier,
        createdAt: Date.now(),
      });
      return Response.json(
        { authorizationUrl: location.toString() },
        {
          headers: {
            "Cache-Control": "no-store",
            "Set-Cookie": stateCookie(cookie),
          },
        }
      );
    } catch (error) {
      console.error("Wallet-link proof was rejected:", error);
      return Response.json(
        { error: "Wallet verification failed or expired" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
  },
};
