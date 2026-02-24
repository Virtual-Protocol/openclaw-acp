// =============================================================================
// acp social twitter login    — Get Twitter/X authentication link
// acp social twitter post     — Post a tweet
// acp social twitter reply    — Reply to a tweet
// acp social twitter search   — Search tweets
// acp social twitter timeline — Get timeline tweets
// acp social twitter logout   — Log out from Twitter/X
// =============================================================================

import {
  getAuthLink,
  onboard,
  postTweet,
  replyTweet,
  searchTweets,
  getTimeline,
  type SearchTweetsParams,
  SortOrder,
} from "../lib/twitterApi.js";
import { openUrl } from "../lib/open.js";
import * as output from "../lib/output.js";

export async function auth(): Promise<void> {
  try {
    output.log("");
    output.warn("By authenticating with Twitter/X, you are granting this agent permission");
    output.warn("to perform actions on your behalf, including posting tweets, replying,");
    output.warn("and browsing your timeline on the authenticated Twitter/X account.");
    output.log("");

    output.log("  Getting Twitter/X authentication link...\n");

    const authLink = await getAuthLink();

    output.log(`  Opening browser...`);
    openUrl(authLink);
    output.log(`  Auth link: ${authLink}\n`);
    output.success("Twitter/X authentication link opened in your browser.");

    output.log("");
    output.warn("Reminder: completing this authentication will allow the agent to post,");
    output.warn("reply, and browse Twitter/X on behalf of the authenticated account.");
    output.warn("You can revoke access at any time by using command `acp social twitter logout`.");
    output.log("");
  } catch (e) {
    output.fatal(
      `Failed to get Twitter/X auth link: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export async function post(tweetText: string): Promise<void> {
  if (!tweetText?.trim()) {
    output.fatal("Usage: acp social twitter post <tweet-text>\n  Tweet text cannot be empty.");
  }

  try {
    output.log("  Posting tweet...\n");

    const result = await postTweet(tweetText);

    output.output(result, (data) => {
      output.heading("Tweet Posted");
      output.log(`  Tweet: "${tweetText}"`);
      if (data?.tweetId) {
        output.field("Tweet ID", data.tweetId);
      }
      if (data?.url) {
        output.field("URL", data.url);
      }
      output.log("");
    });

    output.success(`Tweet posted successfully! https://x.com/acp/status/${result.data.tweetId}`);
  } catch (e) {
    output.fatal(`Failed to post tweet: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function reply(tweetId: string, replyText: string): Promise<void> {
  if (!tweetId?.trim()) {
    output.fatal(
      "Usage: acp social twitter reply <tweet-id> <reply-text>\n  Tweet ID cannot be empty."
    );
  }

  if (!replyText?.trim()) {
    output.fatal(
      "Usage: acp social twitter reply <tweet-id> <reply-text>\n  Reply text cannot be empty."
    );
  }

  try {
    output.log("  Replying to tweet...\n");

    const result = await replyTweet(tweetId, replyText);

    output.output(result, (data) => {
      output.heading("Reply Posted");
      output.log(`  Replying to tweet ID: ${tweetId}`);
      output.log(`  Reply: "${replyText}"`);
      if (data?.tweetId) {
        output.field("Reply Tweet ID", data.tweetId);
      }
      output.log("");
    });

    const replyId = result.data?.tweetId;
    if (replyId) {
      output.success(`Reply posted successfully! https://x.com/acp/status/${replyId}`);
    } else {
      output.success("Reply posted successfully!");
    }
  } catch (e) {
    output.fatal(`Failed to reply to tweet: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function search(
  query: string,
  options?: {
    maxResults?: number;
    excludeRetweets?: boolean;
    sortOrder?: "relevancy" | "recency";
  }
): Promise<void> {
  if (!query?.trim()) {
    output.fatal("Usage: acp social twitter search <query> [options]\n  Query cannot be empty.");
  }

  try {
    output.log("  Searching tweets...\n");

    const searchParams: SearchTweetsParams = {
      query,
      maxResults: options?.maxResults,
      excludeRetweets: options?.excludeRetweets,
      sortOrder: options?.sortOrder
        ? options.sortOrder === "relevancy"
          ? SortOrder.RELEVANCY
          : SortOrder.RECENCY
        : undefined,
    };

    const result = await searchTweets(searchParams);

    output.output(result, (data) => {
      output.heading("Search Results");
      output.log(`  Query: "${query}"`);
      if (data?.meta?.result_count !== undefined) {
        output.field("Result Count", String(data.meta.result_count));
      }
      if (data?.meta?.next_token) {
        output.field("Next Token", data.meta.next_token);
      }
      output.log("");

      if (data?.data && data.data.length > 0) {
        data.data.forEach((tweet: any, index: number) => {
          const text = JSON.stringify(tweet.text);
          const author = tweet.author?.username || "unknown";
          output.field("Tweet ID", tweet.id);
          output.field("Author", author);
          output.field("Text", text);
          output.log("");
        });
        output.log("");
      } else {
        output.log("  No tweets found.");
        output.log("");
      }
    });
  } catch (e) {
    output.fatal(`Failed to search tweets: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function timeline(maxResults?: number): Promise<void> {
  try {
    output.log("  Fetching timeline...\n");

    const result = await getTimeline(maxResults);

    output.output(result, (data) => {
      output.heading("Timeline");
      if (data?.meta?.result_count !== undefined) {
        output.field("Tweet Count", String(data.meta.result_count));
      }
      output.log("");

      if (data?.data && data.data.length > 0) {
        output.log("  Tweets:");
        data.data.forEach((tweet: any, index: number) => {
          const text = JSON.stringify(tweet.text);
          const author = tweet.author?.username || "unknown";
          output.field("Tweet ID", tweet.id);
          output.field("Author", author);
          output.field("Text", text);
          output.log("");
        });
        output.log("");
      } else {
        output.log("  No tweets in timeline.");
        output.log("");
      }
    });
  } catch (e) {
    output.fatal(`Failed to fetch timeline: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function logout(): Promise<void> {
  try {
    output.log("  Logging out from Twitter/X...\n");

    await logout();

    output.success("Logged out from Twitter/X successfully!");
  } catch (e) {
    output.fatal(`Failed to logout from Twitter/X: ${e instanceof Error ? e.message : String(e)}`);
  }
}
