import { botCredentials, refreshBotCredentials } from "./x-auth.mjs";

async function requestWithCredentials(credentials, path, init = {}) {
  const response = await fetch(`https://api.x.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${credentials.tokens.access_token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return response;
}

export async function xApiRequest(path, init = {}) {
  let credentials = await botCredentials();
  let response = await requestWithCredentials(credentials, path, init);
  if (response.status === 401) {
    credentials = await refreshBotCredentials(credentials);
    response = await requestWithCredentials(credentials, path, init);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.detail ?? body?.title ?? "X API request failed";
    throw new Error(`${detail} (${response.status})`);
  }
  return body;
}

export async function fetchBotMentions({ botUserId, sinceId, maxPages = 10 }) {
  const mentions = [];
  const users = new Map();
  let paginationToken;

  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({
      max_results: "100",
      "tweet.fields":
        "author_id,created_at,entities,in_reply_to_user_id,referenced_tweets",
      expansions: "author_id,entities.mentions.username,in_reply_to_user_id",
      "user.fields": "id,username",
    });
    if (sinceId) query.set("since_id", sinceId);
    if (paginationToken) query.set("pagination_token", paginationToken);
    const body = await xApiRequest(
      `/2/users/${encodeURIComponent(botUserId)}/mentions?${query}`
    );
    for (const user of body.includes?.users ?? []) users.set(user.id, user);
    mentions.push(...(body.data ?? []));
    paginationToken = body.meta?.next_token;
    if (!paginationToken) break;
  }

  return { mentions, users, truncated: Boolean(paginationToken) };
}

export async function replyToPost(text, postId) {
  const body = await xApiRequest("/2/tweets", {
    method: "POST",
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: postId } }),
  });
  return body.data?.id ?? null;
}
