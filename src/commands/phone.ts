// =============================================================================
// acp phone setup   — Configure ClawdTalk voice integration
// acp phone status  — Check phone number status
// acp phone call    — Make an outbound voice call
// acp phone sms     — Send an SMS message
// =============================================================================

import * as output from "../lib/output.js";
import { readConfig, writeConfig, ROOT } from "../lib/config.js";
import readline from "readline";
import WebSocket from "ws";
import axios from "axios";

// -- Types --

interface ClawdTalkConfig {
  api_key?: string;
  server?: string;
  phone_number?: string;
}

interface PhoneConfig {
  clawdtalk?: ClawdTalkConfig;
}

// -- Helpers --

const CLAWDTALK_SERVER = "https://clawdtalk.com";

function getPhoneConfig(): PhoneConfig {
  const config = readConfig();
  return config as PhoneConfig;
}

function savePhoneConfig(phoneConfig: PhoneConfig): void {
  const config = readConfig();
  config.clawdtalk = phoneConfig.clawdtalk;
  writeConfig(config);
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// -- Commands --

/**
 * Setup ClawdTalk integration - prompts for API key and verifies connection
 */
export async function setup(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    output.heading("ClawdTalk Voice Integration");
    output.log("");
    output.log("  Give your Virtuals agent a phone number for voice calls and SMS.");
    output.log("  Get your API key at: https://clawdtalk.com");
    output.log("");

    const config = getPhoneConfig();
    const existingKey = config.clawdtalk?.api_key;

    if (existingKey) {
      output.log(`  Existing API key: ${existingKey.slice(0, 8)}...${existingKey.slice(-4)}`);
      const overwrite = await question(rl, "  Update API key? [y/N]: ");
      if (overwrite.toLowerCase() !== "y") {
        output.log("\n  Keeping existing configuration.\n");
        return;
      }
    }

    const apiKey = await question(rl, "  Enter your ClawdTalk API key: ");
    
    if (!apiKey || !apiKey.startsWith("cc_")) {
      output.fatal("Invalid API key. Must start with 'cc_'");
      return;
    }

    // Verify API key by checking status
    output.log("\n  Verifying API key...");
    
    try {
      const response = await axios.get(`${CLAWDTALK_SERVER}/api/status`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        timeout: 10000,
      });

      const data = response.data;
      
      savePhoneConfig({
        clawdtalk: {
          api_key: apiKey,
          server: CLAWDTALK_SERVER,
          phone_number: data.phone_number,
        },
      });

      output.log("");
      output.success("ClawdTalk configured successfully!");
      output.field("Phone Number", data.phone_number || "Not assigned");
      output.log("");
      output.log("  Your Virtuals agent can now:");
      output.log("    • Receive voice calls");
      output.log("    • Make outbound calls (acp phone call)");
      output.log("    • Send and receive SMS (acp phone sms)");
      output.log("");

    } catch (e: any) {
      if (e.response?.status === 401) {
        output.fatal("Invalid API key. Please check and try again.");
      } else {
        output.fatal(`Failed to verify API key: ${e.message}`);
      }
    }

  } finally {
    rl.close();
  }
}

/**
 * Show current phone number and connection status
 */
export async function status(): Promise<void> {
  const config = getPhoneConfig();

  output.heading("ClawdTalk Status");

  if (!config.clawdtalk?.api_key) {
    output.log("");
    output.warn("  Not configured. Run: acp phone setup");
    output.log("");
    return;
  }

  try {
    const response = await axios.get(`${config.clawdtalk.server || CLAWDTALK_SERVER}/api/status`, {
      headers: { "Authorization": `Bearer ${config.clawdtalk.api_key}` },
      timeout: 10000,
    });

    const data = response.data;

    output.output(
      {
        phone_number: data.phone_number,
        status: data.status || "active",
        websocket: data.websocket_connected ? "connected" : "disconnected",
      },
      (info) => {
        output.field("Phone Number", info.phone_number || "Not assigned");
        output.field("Status", info.status);
        output.field("WebSocket", info.websocket);
        output.log("");
      }
    );

  } catch (e: any) {
    output.fatal(`Failed to check status: ${e.message}`);
  }
}

/**
 * Make an outbound voice call
 */
export async function call(to: string, message?: string): Promise<void> {
  const config = getPhoneConfig();

  if (!config.clawdtalk?.api_key) {
    output.fatal("Not configured. Run: acp phone setup");
    return;
  }

  if (!to) {
    output.fatal("Phone number required. Usage: acp phone call +15551234567 [\"greeting message\"]");
    return;
  }

  try {
    output.log(`\n  Calling ${to}...`);

    const response = await axios.post(
      `${config.clawdtalk.server || CLAWDTALK_SERVER}/api/call`,
      {
        to,
        greeting: message || "Hello, this is your Virtuals agent calling.",
      },
      {
        headers: { "Authorization": `Bearer ${config.clawdtalk.api_key}` },
        timeout: 30000,
      }
    );

    const data = response.data;

    output.output(
      {
        call_id: data.call_id,
        to: to,
        status: data.status || "initiated",
      },
      (info) => {
        output.success("Call initiated!");
        output.field("Call ID", info.call_id);
        output.field("To", info.to);
        output.field("Status", info.status);
        output.log("");
        output.log("  Check status: acp phone call-status " + info.call_id);
        output.log("  End call: acp phone call-end " + info.call_id);
        output.log("");
      }
    );

  } catch (e: any) {
    output.fatal(`Failed to make call: ${e.response?.data?.error || e.message}`);
  }
}

/**
 * Check outbound call status
 */
export async function callStatus(callId: string): Promise<void> {
  const config = getPhoneConfig();

  if (!config.clawdtalk?.api_key) {
    output.fatal("Not configured. Run: acp phone setup");
    return;
  }

  if (!callId) {
    output.fatal("Call ID required. Usage: acp phone call-status <call-id>");
    return;
  }

  try {
    const response = await axios.get(
      `${config.clawdtalk.server || CLAWDTALK_SERVER}/api/call/${callId}`,
      {
        headers: { "Authorization": `Bearer ${config.clawdtalk.api_key}` },
        timeout: 10000,
      }
    );

    const data = response.data;

    output.output(
      {
        call_id: data.call_id,
        status: data.status,
        duration: data.duration,
        to: data.to,
      },
      (info) => {
        output.heading("Call Status");
        output.field("Call ID", info.call_id);
        output.field("Status", info.status);
        output.field("To", info.to);
        if (info.duration) output.field("Duration", `${info.duration}s`);
        output.log("");
      }
    );

  } catch (e: any) {
    output.fatal(`Failed to get call status: ${e.response?.data?.error || e.message}`);
  }
}

/**
 * End an active call
 */
export async function callEnd(callId: string): Promise<void> {
  const config = getPhoneConfig();

  if (!config.clawdtalk?.api_key) {
    output.fatal("Not configured. Run: acp phone setup");
    return;
  }

  if (!callId) {
    output.fatal("Call ID required. Usage: acp phone call-end <call-id>");
    return;
  }

  try {
    const response = await axios.post(
      `${config.clawdtalk.server || CLAWDTALK_SERVER}/api/call/${callId}/end`,
      {},
      {
        headers: { "Authorization": `Bearer ${config.clawdtalk.api_key}` },
        timeout: 10000,
      }
    );

    output.success("Call ended.");

  } catch (e: any) {
    output.fatal(`Failed to end call: ${e.response?.data?.error || e.message}`);
  }
}

/**
 * Send an SMS message
 */
export async function sms(to: string, body: string, media?: string): Promise<void> {
  const config = getPhoneConfig();

  if (!config.clawdtalk?.api_key) {
    output.fatal("Not configured. Run: acp phone setup");
    return;
  }

  if (!to || !body) {
    output.fatal('Phone number and message required. Usage: acp phone sms +15551234567 "Hello!" [--media url]');
    return;
  }

  try {
    const payload: Record<string, any> = { to, body };
    if (media) payload.media = media;

    const response = await axios.post(
      `${config.clawdtalk.server || CLAWDTALK_SERVER}/api/sms`,
      payload,
      {
        headers: { "Authorization": `Bearer ${config.clawdtalk.api_key}` },
        timeout: 10000,
      }
    );

    const data = response.data;

    output.output(
      {
        message_id: data.message_id,
        to: to,
        status: data.status || "sent",
      },
      (info) => {
        output.success("SMS sent!");
        output.field("Message ID", info.message_id);
        output.field("To", info.to);
        output.field("Status", info.status);
        output.log("");
      }
    );

  } catch (e: any) {
    output.fatal(`Failed to send SMS: ${e.response?.data?.error || e.message}`);
  }
}

/**
 * List recent SMS messages
 */
export async function smsList(contact?: string): Promise<void> {
  const config = getPhoneConfig();

  if (!config.clawdtalk?.api_key) {
    output.fatal("Not configured. Run: acp phone setup");
    return;
  }

  try {
    const params = contact ? { contact } : {};
    const response = await axios.get(
      `${config.clawdtalk.server || CLAWDTALK_SERVER}/api/sms`,
      {
        params,
        headers: { "Authorization": `Bearer ${config.clawdtalk.api_key}` },
        timeout: 10000,
      }
    );

    const messages = response.data.messages || [];

    output.output(
      { messages },
      (data) => {
        output.heading("SMS Messages");
        if (data.messages.length === 0) {
          output.log("  No messages found.\n");
          return;
        }
        for (const msg of data.messages) {
          const dir = msg.direction === "inbound" ? "←" : "→";
          output.log(`  ${dir} ${msg.from || msg.to}: ${msg.body.slice(0, 50)}...`);
        }
        output.log("");
      }
    );

  } catch (e: any) {
    output.fatal(`Failed to list SMS: ${e.response?.data?.error || e.message}`);
  }
}

/**
 * Start the WebSocket connection for inbound calls
 */
export async function connect(): Promise<void> {
  const config = getPhoneConfig();

  if (!config.clawdtalk?.api_key) {
    output.fatal("Not configured. Run: acp phone setup");
    return;
  }

  const server = config.clawdtalk.server || CLAWDTALK_SERVER;
  const wsUrl = server.replace("https://", "wss://").replace("http://", "ws://") + "/ws";

  output.log(`\n  Connecting to ${wsUrl}...`);

  const ws = new WebSocket(wsUrl, {
    headers: {
      "Authorization": `Bearer ${config.clawdtalk.api_key}`,
    },
  });

  ws.on("open", () => {
    output.success("WebSocket connected. Listening for calls...");
    output.log("  Press Ctrl+C to disconnect.\n");
  });

  ws.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());
      output.log(`  Event: ${event.type} - ${JSON.stringify(event.data)}`);
    } catch {
      output.log(`  Message: ${data.toString()}`);
    }
  });

  ws.on("error", (err) => {
    output.fatal(`WebSocket error: ${err.message}`);
  });

  ws.on("close", () => {
    output.log("\n  WebSocket disconnected.\n");
    process.exit(0);
  });

  // Keep process alive
  process.stdin.resume();
}
