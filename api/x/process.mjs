import {
  authorizeProcessorRequest,
  processXMentions,
} from "../_lib/x-processor.mjs";

export default {
  async fetch(request) {
    if (!authorizeProcessorRequest(request)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      return Response.json(await processXMentions(), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error("X mention processor failed:", error);
      return Response.json(
        { error: "X mention processing failed" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
  },
};
