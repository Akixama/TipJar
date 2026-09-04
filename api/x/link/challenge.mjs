import { createWalletLinkChallenge } from "../../_lib/x-auth.mjs";

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    try {
      const { wallet } = await request.json();
      const challenge = await createWalletLinkChallenge(wallet);
      return Response.json(challenge, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error("Could not create wallet-link challenge:", error);
      return Response.json(
        { error: "Could not create a wallet verification request" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
  },
};
