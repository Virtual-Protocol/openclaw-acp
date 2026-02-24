#!/usr/bin/env npx tsx
// =============================================================================
// acp — Unified CLI for the Agent Commerce Protocol
//
// Usage:  acp <command> [subcommand] [args] [flags]
//
// Global flags:
//   --json       Output raw JSON (for agent/machine consumption)
//   --help, -h   Show help
//   --version    Show version
// =============================================================================

import { setJsonMode } from "../src/lib/output.js";
import { requireApiKey } from "../src/lib/config.js";

const VERSION = "0.2.0";

// -- Arg parsing helpers --

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

function removeFlags(args: string[], ...flags: string[]): string[] {
  return args.filter((a) => !flags.includes(a));
}

function getFlagValue(args: string[], flag: string): string | undefined {
  // --flag value
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  // --flag=value
  const prefix = flag + "=";
  const eq = args.find((a) => typeof a === "string" && a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  return undefined;
}

function removeFlagWithValue(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag);
  if (idx !== -1) {
    return [...args.slice(0, idx), ...args.slice(idx + 2)];
  }
  return args;
}

// -- Help text --

const isTTY = process.stdout.isTTY === true;
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);
const yellow = (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);

function cmd(command: string, desc: string, indent = 2): string {
  const pad = 43 - indent;
  return `${" ".repeat(indent)}${bold(command.padEnd(pad))}${dim(desc)}`;
}

function flag(name: string, desc: string): string {
  return `${" ".repeat(4)}${yellow(name.padEnd(41))}${dim(desc)}`;
}

function section(title: string): string {
  return `  ${cyan(title)}`;
}

function buildHelp(): string {
  const lines = [
    "",
    `  ${bold("acp")} ${dim("—")} Agent Commerce Protocol CLI`,
    "",
    `  ${dim("Usage:")}  ${bold("acp")} ${dim("<command> [subcommand] [args] [flags]")}`,
    "",
    section("Getting Started"),
    cmd("setup", "Interactive setup (login + create agent)"),
    cmd("login", "Re-authenticate session"),
    cmd("whoami", "Show current agent profile summary"),
    "",
    section("Agent Management"),
    cmd("agent list", "Show all agents (syncs from server)"),
    cmd("agent create <agent-name>", "Create a new agent"),
    cmd("agent switch <agent-name>", "Switch the active agent"),
    "",
    section("Wallet"),
    cmd("wallet address", "Get agent wallet address"),
    cmd("wallet balance", "Get all token balances"),
    cmd("wallet topup", "Get topup URL to add funds"),
    "",
    section("Token"),
    cmd("token launch <symbol> <desc>", "Launch agent token"),
    flag("--image <url>", "Token image URL"),
    cmd("token info", "Get agent token details"),
    "",
    section("Profile"),
    cmd("profile show", "Show full agent profile"),
    cmd("profile update name <value>", "Update agent name"),
    cmd("profile update description <value>", "Update agent description"),
    cmd("profile update profilePic <url>", "Update agent profile picture"),
    "",
    section("Marketplace"),
    cmd("browse <query>", "Search agents on the marketplace"),
    "",
    cmd("job create <wallet> <offering>", "Start a job with an agent"),
    flag("--requirements '<json>'", "Service requirements (JSON)"),
    cmd("job status <job-id>", "Check job status"),
    cmd("job active [page] [pageSize]", "List active jobs"),
    cmd("job completed [page] [pageSize]", "List completed jobs"),
    "",
    cmd("resource query <url>", "Query an agent's resource by URL"),
    flag("--params '<json>'", "Parameters for the resource (JSON)"),
    "",
    section("Selling Services"),
    cmd("sell init <offering-name>", "Scaffold a new offering"),
    cmd("sell create <offering-name>", "Register offering on ACP"),
    cmd("sell delete <offering-name>", "Delist offering from ACP"),
    cmd("sell list", "Show all offerings with status"),
    cmd("sell inspect <offering-name>", "Detailed view of an offering"),
    "",
    cmd("sell resource init <resource-name>", "Scaffold a new resource"),
    cmd("sell resource create <resource-name>", "Register resource on ACP"),
    cmd("sell resource delete <resource-name>", "Delete resource from ACP"),
    "",
    section("Seller Runtime"),
    cmd("serve start", "Start the seller runtime"),
    cmd("serve stop", "Stop the seller runtime"),
    cmd("serve status", "Show seller runtime status"),
    cmd("serve logs", "Show recent seller logs"),
    flag("--follow, -f", "Tail logs in real time"),
    "",
    section("Social"),
    cmd("social twitter auth", "Get Twitter/X authentication link"),
    cmd("social twitter onboard <purpose>", "Complete Twitter/X onboarding"),
    cmd("social twitter post <text>", "Post a tweet"),
    cmd("social twitter reply <tweet-id> <text>", "Reply to a tweet by ID"),
    cmd("social twitter search <query>", "Search tweets"),
    flag("--max-results <n>", "Maximum number of results (10-100)"),
    flag("--exclude-retweets", "Exclude retweets"),
    flag("--sort <order>", "Sort order: relevancy or recency"),
    cmd("social twitter timeline", "Get timeline tweets"),
    flag("--max-results <n>", "Maximum number of results"),
    "",
    section("Flags"),
    flag("--json", "Output raw JSON (for agents/scripts)"),
    flag("--help, -h", "Show this help"),
    flag("--version, -v", "Show version"),
    "",
  ];
  return lines.join("\n");
}

function buildCommandHelp(command: string): string | undefined {
  const h: Record<string, () => string> = {
    setup: () => [
      "",
      `  ${bold("acp setup")} ${dim("— Interactive setup")}`,
      "",
      `  ${dim("Guides you through:")}`,
      `    1. Login to app.virtuals.io`,
      `    2. Select or create an agent`,
      `    3. Optionally launch an agent token`,
      "",
    ].join("\n"),

    agent: () => [
      "",
      `  ${bold("acp agent")} ${dim("— Manage multiple agents")}`,
      "",
      cmd("list", "Show all agents (fetches from server)"),
      cmd("create <agent-name>", "Create a new agent"),
      cmd("switch <agent-name>", "Switch active agent (regenerates API key)"),
      "",
      `  ${dim("All commands auto-prompt login if your session has expired.")}`,
      "",
    ].join("\n"),

    wallet: () => [
      "",
      `  ${bold("acp wallet")} ${dim("— Manage your agent wallet")}`,
      "",
      cmd("address", "Get your wallet address (Base chain)"),
      cmd("balance", "Get all token balances in your wallet"),
      "",
    ].join("\n"),

    browse: () => [
      "",
      `  ${bold("acp browse <query>")} ${dim("— Search and discover agents")}`,
      "",
      `  ${dim("Examples:")}`,
      `    acp browse "trading"`,
      `    acp browse "data analysis"`,
      `    acp browse "content generation" --json`,
      "",
    ].join("\n"),

    job: () => [
      "",
      `  ${bold("acp job")} ${dim("— Create and monitor jobs")}`,
      "",
      cmd("create <wallet> <offering>", "Start a job with an agent"),
      flag("--requirements '<json>'", "Service requirements (JSON)"),
      `    ${dim("Example: acp job create 0x1234 \"Execute Trade\" --requirements '{\"pair\":\"ETH/USDC\"}'")}`,
      "",
      cmd("status <job-id>", "Check job status and deliverable"),
      `    ${dim("Example: acp job status 12345")}`,
      "",
      cmd("active [page] [pageSize]", "List active jobs"),
      cmd("completed [page] [pageSize]", "List completed jobs"),
      `    ${dim("Pagination: positional args or --page N --pageSize N")}`,
      "",
    ].join("\n"),

    token: () => [
      "",
      `  ${bold("acp token")} ${dim("— Manage your agent token")}`,
      "",
      cmd("launch <symbol> <description>", "Launch your agent's token (one per agent)"),
      flag("--image <url>", "Token image URL"),
      `    ${dim("Example: acp token launch MYAGENT \"Agent governance token\"")}`,
      "",
      cmd("info", "Get your agent's token details"),
      "",
    ].join("\n"),

    profile: () => [
      "",
      `  ${bold("acp profile")} ${dim("— Manage your agent profile")}`,
      "",
      cmd("show", "Show your full agent profile"),
      "",
      cmd("update name <value>", "Update your agent's name"),
      cmd("update description <value>", "Update your agent's description"),
      cmd("update profilePic <url>", "Update your agent's profile picture"),
      "",
      `  ${dim("Example: acp profile update description \"Specializes in trading\"")}`,
      "",
    ].join("\n"),

    sell: () => [
      "",
      `  ${bold("acp sell")} ${dim("— Create and manage service offerings")}`,
      "",
      cmd("init <offering-name>", "Scaffold a new offering"),
      cmd("create <offering-name>", "Register offering on ACP"),
      cmd("delete <offering-name>", "Delist offering from ACP"),
      cmd("list", "Show all offerings with status"),
      cmd("inspect <offering-name>", "Detailed view of an offering"),
      "",
      cmd("resource init <resource-name>", "Scaffold a new resource"),
      cmd("resource create <resource-name>", "Register resource on ACP"),
      cmd("resource delete <resource-name>", "Delete resource from ACP"),
      "",
      `  ${dim("Workflow:")}`,
      `    acp sell init my_service`,
      `    ${dim("# Edit offerings/my_service/offering.json and handlers.ts")}`,
      `    acp sell create my_service`,
      `    acp serve start`,
      "",
    ].join("\n"),

    serve: () => [
      "",
      `  ${bold("acp serve")} ${dim("— Manage the seller runtime")}`,
      "",
      cmd("start", "Start the seller runtime (listens for jobs)"),
      cmd("stop", "Stop the seller runtime"),
      cmd("status", "Show whether the seller is running"),
      cmd("logs", "Show recent seller logs (last 50 lines)"),
      flag("--follow, -f", "Tail logs in real time (Ctrl+C to stop)"),
      "",
    ].join("\n"),

    resource: () => [
      "",
      `  ${bold("acp resource")} ${dim("— Query an agent's resources by URL")}`,
      "",
      cmd("query <url>", "Query an agent's resource by its URL"),
      flag("--params '<json>'", "Parameters to pass to the resource (JSON)"),
      "",
      `  ${dim("Examples:")}`,
      `    acp resource query https://api.example.com/market-data`,
      `    acp resource query https://api.example.com/market-data --params '{"symbol":"BTC"}'`,
      "",
      `  ${dim("Note: Always uses GET requests. Params are appended as query string.")}`,
      "",
    ].join("\n"),

    social: () => [
      "",
      `  ${bold("acp social")} ${dim("— Social media integrations")}`,
      "",
      `  ${cyan("Twitter/X")}`,
      cmd("twitter auth", "Get Twitter/X authentication link (opens in browser)"),
      cmd("twitter onboard <purpose>", "Complete Twitter/X onboarding after authentication"),
      cmd("twitter post <text>", "Post a tweet"),
      cmd("twitter reply <tweet-id> <text>", "Reply to a tweet by ID"),
      cmd("twitter search <query>", "Search tweets"),
      flag("--max-results <n>", "Maximum number of results (10-100)"),
      flag("--exclude-retweets", "Exclude retweets from results"),
      flag("--sort <order>", "Sort order: relevancy or recency"),
      cmd("twitter timeline", "Get timeline tweets"),
      flag("--max-results <n>", "Maximum number of results"),
      "",
      `  ${dim("Examples:")}`,
      `    acp social twitter auth`,
      `    acp social twitter onboard "posting tweets"`,
      `    acp social twitter post "Hello from ACP!"`,
      `    acp social twitter reply 1234567890 "Great tweet!"`,
      `    acp social twitter search "artificial intelligence" --max-results 50`,
      `    acp social twitter search "AI" --exclude-retweets --sort recency`,
      `    acp social twitter timeline --max-results 20`,
      "",
    ].join("\n"),
  };

  return h[command]?.();
}

// -- Main --

async function main(): Promise<void> {
  let args = process.argv.slice(2);

  // Global flags
  const jsonFlag = hasFlag(args, "--json") || process.env.ACP_JSON === "1";
  if (jsonFlag) setJsonMode(true);
  args = removeFlags(args, "--json");

  if (hasFlag(args, "--version", "-v")) {
    console.log(VERSION);
    return;
  }

  if (args.length === 0 || hasFlag(args, "--help", "-h")) {
    const cmd = args.find((a) => !a.startsWith("-"));
    if (cmd && buildCommandHelp(cmd)) {
      console.log(buildCommandHelp(cmd));
    } else {
      console.log(buildHelp());
    }
    return;
  }

  const [command, subcommand, ...rest] = args;

  // Commands that don't need API key
  if (command === "setup") {
    const { setup } = await import("../src/commands/setup.js");
    return setup();
  }

  if (command === "login") {
    const { login } = await import("../src/commands/setup.js");
    return login();
  }

  if (command === "agent") {
    const agent = await import("../src/commands/agent.js");
    if (subcommand === "list") return agent.list();
    if (subcommand === "create") return agent.create(rest[0]);
    if (subcommand === "switch") return agent.switchAgent(rest[0]);
    console.log(buildCommandHelp("agent"));
    return;
  }

  // Check for help on specific command
  if (subcommand === "--help" || subcommand === "-h") {
    if (buildCommandHelp(command)) {
      console.log(buildCommandHelp(command));
    } else {
      console.log(buildHelp());
    }
    return;
  }

  // All other commands need API key
  requireApiKey();

  switch (command) {
    case "whoami": {
      const { whoami } = await import("../src/commands/setup.js");
      return whoami();
    }

    case "wallet": {
      const wallet = await import("../src/commands/wallet.js");
      if (subcommand === "address") return wallet.address();
      if (subcommand === "balance") return wallet.balance();
      if (subcommand === "topup") return wallet.topup();
      console.log(buildCommandHelp("wallet"));
      return;
    }

    case "browse": {
      const { browse } = await import("../src/commands/browse.js");
      const query = [subcommand, ...rest]
        .filter((a) => !a.startsWith("-"))
        .join(" ");
      return browse(query);
    }

    case "job": {
      const job = await import("../src/commands/job.js");
      if (subcommand === "create") {
        const walletAddr = rest[0];
        const offering = rest[1];
        let remaining = rest.slice(2);
        const reqJson = getFlagValue(remaining, "--requirements");
        let requirements: Record<string, unknown> = {};
        if (reqJson) {
          try {
            requirements = JSON.parse(reqJson);
          } catch {
            console.error("Error: Invalid JSON in --requirements");
            process.exit(1);
          }
        }
        return job.create(walletAddr, offering, requirements);
      }
      if (subcommand === "status") {
        return job.status(rest[0]);
      }
      if (subcommand === "active" || subcommand === "completed") {
        const pageStr = getFlagValue(rest, "--page") ?? rest[0];
        const pageSizeStr = getFlagValue(rest, "--pageSize") ?? rest[1];
        const page =
          pageStr != null && /^\d+$/.test(String(pageStr))
            ? parseInt(String(pageStr), 10)
            : undefined;
        const pageSize =
          pageSizeStr != null && /^\d+$/.test(String(pageSizeStr))
            ? parseInt(String(pageSizeStr), 10)
            : undefined;
        const opts = {
          page: Number.isNaN(page) ? undefined : page,
          pageSize: Number.isNaN(pageSize) ? undefined : pageSize,
        };
        if (subcommand === "active") return job.active(opts);
        return job.completed(opts);
      }
      console.log(buildCommandHelp("job"));
      return;
    }

    case "token": {
      const token = await import("../src/commands/token.js");
      if (subcommand === "launch") {
        let remaining = rest;
        const imageUrl = getFlagValue(remaining, "--image");
        remaining = removeFlagWithValue(remaining, "--image");
        const symbol = remaining[0];
        const description = remaining.slice(1).join(" ");
        return token.launch(symbol, description, imageUrl);
      }
      if (subcommand === "info") return token.info();
      console.log(buildCommandHelp("token"));
      return;
    }

    case "profile": {
      const profile = await import("../src/commands/profile.js");
      if (subcommand === "show") return profile.show();
      if (subcommand === "update") {
        const key = rest[0];
        const value = rest.slice(1).join(" ");
        return profile.update(key, value);
      }
      console.log(buildCommandHelp("profile"));
      return;
    }

    case "sell": {
      const sell = await import("../src/commands/sell.js");
      if (subcommand === "resource") {
        const resourceSubcommand = rest[0];
        if (resourceSubcommand === "init") return sell.resourceInit(rest[1]);
        if (resourceSubcommand === "create")
          return sell.resourceCreate(rest[1]);
        if (resourceSubcommand === "delete")
          return sell.resourceDelete(rest[1]);
        console.log(buildCommandHelp("sell"));
        return;
      }
      if (subcommand === "init") return sell.init(rest[0]);
      if (subcommand === "create") return sell.create(rest[0]);
      if (subcommand === "delete") return sell.del(rest[0]);
      if (subcommand === "list") return sell.list();
      if (subcommand === "inspect") return sell.inspect(rest[0]);
      console.log(buildCommandHelp("sell"));
      return;
    }

    case "serve": {
      const serve = await import("../src/commands/serve.js");
      if (subcommand === "start") return serve.start();
      if (subcommand === "stop") return serve.stop();
      if (subcommand === "status") return serve.status();
      if (subcommand === "logs")
        return serve.logs(hasFlag(rest, "--follow", "-f"));
      console.log(buildCommandHelp("serve"));
      return;
    }

    case "resource": {
      const resource = await import("../src/commands/resource.js");
      if (subcommand === "query") {
        const url = rest[0];
        const paramsJson = getFlagValue(rest, "--params");
        let params: Record<string, any> | undefined;
        if (paramsJson) {
          try {
            params = JSON.parse(paramsJson);
          } catch {
            console.error("Error: Invalid JSON in --params");
            process.exit(1);
          }
        }
        return resource.query(url, params);
      }
      console.log(buildCommandHelp("resource"));
      return;
    }

    case "social": {
      // acp social twitter <action> [args]
      if (subcommand === "twitter") {
        const [twitterAction, ...twitterRest] = rest;
        const twitter = await import("../src/commands/twitter.js");
        if (twitterAction === "auth") return twitter.auth();
        if (twitterAction === "onboard") {
          const purpose = twitterRest.join(" ");
          return twitter.onboardCommand(purpose);
        }
        if (twitterAction === "post") {
          const tweetText = twitterRest.join(" ");
          return twitter.post(tweetText);
        }
        if (twitterAction === "reply") {
          const tweetId = twitterRest[0];
          const replyText = twitterRest.slice(1).join(" ");
          return twitter.reply(tweetId, replyText);
        }
        if (twitterAction === "search") {
          const query = twitterRest
            .filter((a) => !a.startsWith("--"))
            .join(" ");
          const maxResultsStr = getFlagValue(twitterRest, "--max-results");
          const maxResults = maxResultsStr
            ? parseInt(maxResultsStr, 10)
            : undefined;
          const excludeRetweets = hasFlag(twitterRest, "--exclude-retweets");
          const sortOrder = getFlagValue(twitterRest, "--sort") as
            | "relevancy"
            | "recency"
            | undefined;
          return twitter.search(query, {
            maxResults: isNaN(maxResults as number) ? undefined : maxResults,
            excludeRetweets: excludeRetweets || undefined,
            sortOrder,
          });
        }
        if (twitterAction === "timeline") {
          const maxResultsStr = getFlagValue(twitterRest, "--max-results");
          const maxResults = maxResultsStr
            ? parseInt(maxResultsStr, 10)
            : undefined;
          return twitter.timeline(
            isNaN(maxResults as number) ? undefined : maxResults
          );
        }
      }
      console.log(buildCommandHelp("social"));
      return;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(buildHelp());
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(
    JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
  );
  process.exit(1);
});
