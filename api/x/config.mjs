export default {
  async fetch() {
    const delegate = process.env.TIPONSOL_DELEGATE_PUBLIC_KEY;
    if (!delegate) {
      return Response.json(
        { error: "The devnet delegate is not configured" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    return Response.json(
      {
        cluster: "devnet",
        programId: "CV75mHHfR1yKnQTowW4TmW7yNTCpk7ET8GYBeu6Wfp5P",
        delegate,
      },
      { headers: { "Cache-Control": "public, max-age=300" } }
    );
  },
};
