// =============================================================================
// ACP API wrappers for twitter usage.
// =============================================================================

import client from "./client.js";

export interface TwitterAuthLinkResponse {
  authUrl: string;
}

export async function getAuthLink(): Promise<string> {
  const { data } = await client.post<{ data: TwitterAuthLinkResponse }>("/x/auth/initiate", {});

  return data.data.authUrl;
}

export interface TwitterOnboardResponse {
  success: boolean;
  message?: string;
}

export interface TwitterPostResponse {
  tweetId: string;
}

export async function onboard(purpose: string): Promise<TwitterOnboardResponse> {
  const { data } = await client.post<{ data: TwitterOnboardResponse }>("/x/auth/onboard", {
    purpose,
  });

  return data.data;
}

export async function postTweet(tweetContent: string): Promise<{ data: TwitterPostResponse }> {
  const { data } = await client.post("/x/post", {
    text: tweetContent,
  });

  return data;
}

export async function replyTweet(
  tweetId: string,
  tweetContent: string
): Promise<{ data: TwitterPostResponse }> {
  const { data } = await client.post("/x/reply", {
    text: tweetContent,
    tweetId,
  });

  return data;
}

// -- Search Types --

export enum SortOrder {
  RELEVANCY = "relevancy",
  RECENCY = "recency",
}

export interface SearchTweetsParams {
  query: string;
  maxResults?: number; // 10-100
  excludeRetweets?: boolean;
  startTime?: string; // ISO 8601 format: YYYY-MM-DDTHH:mm:ssZ
  endTime?: string; // ISO 8601 format: YYYY-MM-DDTHH:mm:ssZ
  sinceId?: string; // Tweet ID to start from (exclusive)
  untilId?: string; // Tweet ID to end at (exclusive)
  nextToken?: string; // Token for pagination
  sortOrder?: SortOrder;
  tweetFields?: string[]; // e.g., ['created_at', 'author_id', 'public_metrics', 'lang', 'entities']
  expansions?: string[]; // e.g., ['author_id', 'referenced_tweets.id', 'attachments.media_keys']
  userFields?: string[]; // e.g., ['username', 'name', 'verified', 'public_metrics']
  mediaFields?: string[]; // e.g., ['type', 'url', 'preview_image_url', 'public_metrics']
}

export interface TwitterSearchResponse {
  data?: any[];
  meta?: {
    result_count?: number;
    next_token?: string;
    previous_token?: string;
  };
  includes?: {
    users?: any[];
    tweets?: any[];
    media?: any[];
  };
  errors?: any[];
}

export async function searchTweets(
  params: SearchTweetsParams
): Promise<{ data: TwitterSearchResponse }> {
  const {
    query,
    maxResults,
    excludeRetweets,
    startTime,
    endTime,
    sinceId,
    untilId,
    nextToken,
    sortOrder,
    tweetFields,
    expansions,
    userFields,
    mediaFields,
  } = params;

  // Build query params object with only defined values
  const queryParams: Record<string, any> = { query };

  // Add optional scalar parameters
  const optionalScalars: Array<[key: string, value: any]> = [
    ["maxResults", maxResults],
    ["excludeRetweets", excludeRetweets],
    ["startTime", startTime],
    ["endTime", endTime],
    ["sinceId", sinceId],
    ["untilId", untilId],
    ["nextToken", nextToken],
    ["sortOrder", sortOrder],
  ];

  for (const [key, value] of optionalScalars) {
    if (value !== undefined && value !== null) {
      queryParams[key] = value;
    }
  }

  // Convert array fields to comma-separated strings
  const arrayFields: Array<[key: string, value: string[] | undefined]> = [
    ["tweetFields", tweetFields],
    ["expansions", expansions],
    ["userFields", userFields],
    ["mediaFields", mediaFields],
  ];

  for (const [key, value] of arrayFields) {
    if (value && value.length > 0) {
      queryParams[key] = value.join(",");
    }
  }

  const { data } = await client.post("/x/search", {
    query: query,
    ...queryParams,
  });

  return data;
}

export async function getTimeline(maxResults?: number) {
  const { data } = await client.post("/x/timeline", {
    params: {
      maxResults,
    },
  });

  return data;
}

export async function logout(): Promise<void> {
  const { data } = await client.post("/x/auth/logout", {});
  return data;
}
