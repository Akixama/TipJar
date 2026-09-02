const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getLatestBlockhash",
  "getSignatureStatuses",
]);

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function jsonError(message, status) {
  return Response.json({ error: message }, { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405);
    }

    const requestUrl = new URL(request.url);
    const origin = request.headers.get("origin");
    if (!origin || origin !== requestUrl.origin) {
      return jsonError("Cross-origin RPC requests are not allowed", 403);
    }

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > 100_000) {
      return jsonError("Request body is too large", 413);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.method !== "string" ||
      !ALLOWED_METHODS.has(payload.method)
    ) {
      return jsonError("Unsupported Solana RPC method", 400);
    }

    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      return jsonError("RPC service is not configured", 503);
    }

    try {
      const upstream = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          cache: "no-store",
        },
      );

      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: JSON_HEADERS,
      });
    } catch {
      return jsonError("RPC service is temporarily unavailable", 502);
    }
  },
};
