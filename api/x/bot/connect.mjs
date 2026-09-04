import {
  authorizationUrl,
  createOauthState,
  oauthRedirectUri,
  signOauthCookie,
  stateCookie,
} from "../../_lib/x-auth.mjs";

export default {
  async fetch(request) {
    try {
      const oauth = createOauthState();
      const redirectUri = oauthRedirectUri(request);
      const location = authorizationUrl({
        state: oauth.state,
        challenge: oauth.challenge,
        redirectUri,
      });
      const cookie = signOauthCookie({
        state: oauth.state,
        verifier: oauth.verifier,
        createdAt: Date.now(),
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: location.toString(),
          "Set-Cookie": stateCookie(cookie),
        },
      });
    } catch (error) {
      console.error("Could not begin X bot authorization:", error);
      return Response.json(
        { error: "X bot authorization is not configured" },
        { status: 503 }
      );
    }
  },
};
