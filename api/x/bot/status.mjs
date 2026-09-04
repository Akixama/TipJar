import { botCredentialStatus } from "../../_lib/x-auth.mjs";

export default {
  async fetch() {
    try {
      const status = await botCredentialStatus();
      return Response.json(
        status ? { connected: true, ...status } : { connected: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      console.error("Could not read X bot status:", error);
      return Response.json(
        { connected: false, error: "Bot status is unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
  },
};
