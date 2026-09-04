import {
  clearStateCookie,
  exchangeAuthorizationCode,
  expectedBotUsername,
  fetchXIdentity,
  htmlPage,
  oauthRedirectUri,
  readStateCookie,
  storeBotCredentials,
  verifyOauthCookie,
} from "../_lib/x-auth.mjs";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const cookie = verifyOauthCookie(readStateCookie(request));
    const responseHeaders = { "Set-Cookie": clearStateCookie() };

    if (error) {
      return htmlPage(
        "Authorization cancelled",
        "X did not authorize TipOnSol.",
        400,
        responseHeaders
      );
    }
    if (!code || !state || !cookie || cookie.state !== state) {
      return htmlPage(
        "Authorization rejected",
        "The OAuth state was missing or invalid. Please start again.",
        400,
        responseHeaders
      );
    }

    try {
      const tokens = await exchangeAuthorizationCode({
        code,
        verifier: cookie.verifier,
        redirectUri: oauthRedirectUri(request),
      });
      const identity = await fetchXIdentity(tokens.access_token);
      const expected = expectedBotUsername();
      if (identity.username.toLowerCase() !== expected.toLowerCase()) {
        return htmlPage(
          "Wrong X account",
          `You authorized @${identity.username}. Sign into @${expected} and try again.`,
          403,
          responseHeaders
        );
      }

      await storeBotCredentials(identity, tokens);
      return htmlPage(
        "@TippOnSol connected",
        "The bot credentials were encrypted and saved. TipOnSol can now act as the bot account.",
        200,
        responseHeaders
      );
    } catch (exchangeError) {
      console.error("X bot callback failed:", exchangeError);
      return htmlPage(
        "Connection failed",
        "TipOnSol could not finish the X connection. Check the server configuration and try again.",
        500,
        responseHeaders
      );
    }
  },
};
