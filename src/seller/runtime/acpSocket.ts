// =============================================================================
// Socket.io client that connects to the ACP backend and dispatches events.
// =============================================================================

import { io, type Socket } from "socket.io-client";
import { SocketEvent, type AcpJobEventData } from "./types.js";

const PAGERDUTY_EVENTS_API_URL = "https://events.pagerduty.com/v2/enqueue";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DISCONNECT_ALERT_THRESHOLD_MS = 2 * 60 * 1000;
const DEFAULT_DISCONNECT_MONITOR_INTERVAL_MS = 30 * 1000;
const DEFAULT_MANUAL_RECONNECT_INTERVAL_MS = 5 * 1000;
const DEFAULT_FAILED_RECONNECTS_BEFORE_ALERT = 3;

type PagerDutyAction = "trigger" | "resolve";

type SocketConnectOptions = {
  auth: { walletAddress: string };
  transports: ["websocket"];
};

export interface SocketLike {
  connected: boolean;
  on(event: string, handler: (...args: any[]) => void): unknown;
  connect(): void;
  disconnect(): void;
}

export interface AcpSocketDeps {
  createSocket?: (acpUrl: string, options: SocketConnectOptions) => SocketLike;
  fetchFn?: typeof fetch;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  nowFn?: () => number;
  heartbeatIntervalMs?: number;
  disconnectAlertThresholdMs?: number;
  disconnectMonitorIntervalMs?: number;
  manualReconnectIntervalMs?: number;
  failedReconnectsBeforeAlert?: number;
}

interface PagerDutyOptions {
  routingKey: string;
  dedupKey: string;
  source: string;
  action: PagerDutyAction;
  summary: string;
  severity?: "critical" | "error" | "warning" | "info";
  details?: Record<string, unknown>;
  fetchFn: typeof fetch;
}

async function sendPagerDutyEvent(opts: PagerDutyOptions): Promise<void> {
  const {
    routingKey,
    dedupKey,
    source,
    action,
    summary,
    severity = "critical",
    details,
    fetchFn,
  } = opts;

  if (!routingKey) {
    console.warn("[socket] PAGERDUTY_ROUTING_KEY not set; skipping PagerDuty event");
    return;
  }

  const payload = {
    routing_key: routingKey,
    event_action: action,
    dedup_key: dedupKey,
    payload: {
      summary,
      source,
      severity,
      component: "acp-socket",
      group: "seller-runtime",
      class: "socket-connectivity",
      custom_details: details ?? {},
    },
  };

  try {
    const response = await fetchFn(PAGERDUTY_EVENTS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      console.error(`[socket] PagerDuty ${action} failed: ${response.status} ${body}`);
      return;
    }

    console.log(`[socket] PagerDuty ${action} sent`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[socket] PagerDuty ${action} error: ${message}`);
  }
}

export interface AcpSocketCallbacks {
  onNewTask: (data: AcpJobEventData) => void;
  onEvaluate?: (data: AcpJobEventData) => void;
}

export interface AcpSocketOptions {
  acpUrl: string;
  walletAddress: string;
  callbacks: AcpSocketCallbacks;
}

/**
 * Connect to the ACP socket and start listening for seller events.
 * Returns a cleanup function that disconnects the socket.
 */
export function connectAcpSocket(opts: AcpSocketOptions, deps: AcpSocketDeps = {}): () => void {
  const { acpUrl, walletAddress, callbacks } = opts;

  const createSocket =
    deps.createSocket ??
    ((url: string, options: SocketConnectOptions): SocketLike => io(url, options) as Socket);
  const fetchFn = deps.fetchFn ?? fetch;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const now = deps.nowFn ?? Date.now;

  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const disconnectAlertThresholdMs =
    deps.disconnectAlertThresholdMs ?? DEFAULT_DISCONNECT_ALERT_THRESHOLD_MS;
  const disconnectMonitorIntervalMs =
    deps.disconnectMonitorIntervalMs ?? DEFAULT_DISCONNECT_MONITOR_INTERVAL_MS;
  const manualReconnectIntervalMs =
    deps.manualReconnectIntervalMs ?? DEFAULT_MANUAL_RECONNECT_INTERVAL_MS;
  const failedReconnectsBeforeAlert =
    deps.failedReconnectsBeforeAlert ?? DEFAULT_FAILED_RECONNECTS_BEFORE_ALERT;

  const pdRoutingKey = process.env.PAGERDUTY_ROUTING_KEY ?? "";
  const pdDedupKey = `acp-socket-${walletAddress.toLowerCase()}`;
  const pdSource = `openclaw-acp-seller:${walletAddress}`;

  let disconnectedAt: number | null = null;
  let failedReconnectAttempts = 0;
  let pdIncidentOpen = false;
  let reconnectInterval: ReturnType<typeof setInterval> | null = null;

  const socket = createSocket(acpUrl, {
    auth: { walletAddress },
    transports: ["websocket"],
  });

  const triggerPagerDuty = (summary: string, details: Record<string, unknown>): void => {
    if (pdIncidentOpen) return;
    pdIncidentOpen = true;
    void sendPagerDutyEvent({
      routingKey: pdRoutingKey,
      dedupKey: pdDedupKey,
      source: pdSource,
      action: "trigger",
      summary,
      severity: "critical",
      details,
      fetchFn,
    });
  };

  const resolvePagerDuty = (summary: string, details: Record<string, unknown>): void => {
    if (!pdIncidentOpen) return;
    pdIncidentOpen = false;
    void sendPagerDutyEvent({
      routingKey: pdRoutingKey,
      dedupKey: pdDedupKey,
      source: pdSource,
      action: "resolve",
      summary,
      severity: "info",
      details,
      fetchFn,
    });
  };

  const stopReconnectLoop = (): void => {
    if (reconnectInterval) {
      clearIntervalFn(reconnectInterval);
      reconnectInterval = null;
    }
  };

  const startReconnectLoop = (): void => {
    if (reconnectInterval) return;

    console.log(
      `[socket] Server-initiated disconnect — starting manual reconnect loop (${manualReconnectIntervalMs}ms)`
    );

    reconnectInterval = setIntervalFn(() => {
      if (socket.connected) {
        stopReconnectLoop();
        return;
      }

      failedReconnectAttempts += 1;
      console.log(`[socket] Manual reconnect attempt #${failedReconnectAttempts}`);
      socket.connect();

      if (failedReconnectAttempts >= failedReconnectsBeforeAlert) {
        triggerPagerDuty(
          `ACP socket failed to reconnect after ${failedReconnectsBeforeAlert} attempts`,
          {
            walletAddress,
            failedReconnectAttempts,
            acpUrl,
          }
        );
      }
    }, manualReconnectIntervalMs);
  };

  socket.on(SocketEvent.ROOM_JOINED, (_data: unknown, callback?: (ack: boolean) => void) => {
    console.log("[socket] Joined ACP room");
    if (typeof callback === "function") callback(true);
  });

  socket.on(SocketEvent.ON_NEW_TASK, (data: AcpJobEventData, callback?: (ack: boolean) => void) => {
    if (typeof callback === "function") callback(true);
    console.log(`[socket] onNewTask  jobId=${data.id}  phase=${data.phase}`);
    callbacks.onNewTask(data);
  });

  socket.on(SocketEvent.ON_EVALUATE, (data: AcpJobEventData, callback?: (ack: boolean) => void) => {
    if (typeof callback === "function") callback(true);
    console.log(`[socket] onEvaluate  jobId=${data.id}  phase=${data.phase}`);
    if (callbacks.onEvaluate) {
      callbacks.onEvaluate(data);
    }
  });

  socket.on("connect", () => {
    const wasDisconnected = disconnectedAt !== null;
    let disconnectedMs = 0;

    if (disconnectedAt !== null) {
      disconnectedMs = now() - disconnectedAt;
    }

    disconnectedAt = null;
    failedReconnectAttempts = 0;
    stopReconnectLoop();

    console.log("[socket] Connected to ACP");

    if (wasDisconnected) {
      resolvePagerDuty("ACP socket reconnected successfully", {
        walletAddress,
        disconnectedMs,
        acpUrl,
      });
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`[socket] Disconnected: ${reason}`);
    if (disconnectedAt === null) {
      disconnectedAt = now();
    }

    // "io server disconnect" = server forcibly closed the connection.
    // Socket.io will NOT auto-reconnect — we must explicitly reconnect.
    if (reason === "io server disconnect") {
      startReconnectLoop();
    }
  });

  socket.on("connect_error", (err: Error) => {
    console.error(`[socket] Connection error: ${err.message}`);
  });

  const heartbeatInterval = setIntervalFn(() => {
    if (socket.connected) {
      console.log("[socket] Heartbeat: connected to ACP");
      return;
    }

    const downForMs = disconnectedAt !== null ? now() - disconnectedAt : 0;
    console.log(`[socket] Heartbeat: disconnected for ${Math.floor(downForMs / 1000)}s`);
  }, heartbeatIntervalMs);

  const disconnectMonitor = setIntervalFn(() => {
    if (disconnectedAt === null) return;

    const downForMs = now() - disconnectedAt;
    if (downForMs > disconnectAlertThresholdMs) {
      triggerPagerDuty("ACP socket disconnected for over 2 minutes", {
        walletAddress,
        disconnectedForSeconds: Math.floor(downForMs / 1000),
        acpUrl,
      });
    }
  }, disconnectMonitorIntervalMs);

  const disconnect = () => {
    stopReconnectLoop();
    clearIntervalFn(heartbeatInterval);
    clearIntervalFn(disconnectMonitor);
    socket.disconnect();
  };

  process.on("SIGINT", () => {
    disconnect();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    disconnect();
    process.exit(0);
  });

  return disconnect;
}
