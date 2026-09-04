import { walletLinkStatus } from "../../_lib/x-auth.mjs";

export default {
  async fetch(request) {
    try {
      const wallet = new URL(request.url).searchParams.get("wallet");
      const link = await walletLinkStatus(wallet);
      return Response.json(
        link ? { linked: true, username: link.username } : { linked: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch {
      return Response.json(
        { linked: false, error: "Invalid wallet address" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
  },
};
