// =============================================================================
// Socket.io client that connects to the ACP backend and dispatches events.
// =============================================================================

import { io, type Socket } from "socket.io-client";
import { SocketEvent, type AcpJobEventData } from "./types.js";

export interface AcpSocketCallbacks {
  onNewTask: (data: AcpJobEventData) => void;
  onEvaluate?: (data: AcpJobEventData) => void;
}

export interface AcpSocketOptions {
  acpUrl: string;
  walletAddress: string;
  callbacks: AcpSocketCallbacks;
}

type LogLevel = "info" | "warn" | "error";
function slog(level: LogLevel, msg: string, fields: Record<string, any> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "acp-seller-socket",
      msg,
      ...fields,
    })
  );
}

/**
 * Connect to the ACP socket and start listening for seller events.
 * Returns a cleanup function that disconnects the socket.
 */
export function connectAcpSocket(opts: AcpSocketOptions): () => void {
  const { acpUrl, walletAddress, callbacks } = opts;

  const socket: Socket = io(acpUrl, {
    auth: { walletAddress: walletAddress.toLowerCase() },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    timeout: 20_000,
  });

  socket.on(SocketEvent.ROOM_JOINED, (_data: unknown, callback?: (ack: boolean) => void) => {
    slog("info", "room joined");
    if (typeof callback === "function") callback(true);
  });

  socket.on(SocketEvent.ON_NEW_TASK, (data: AcpJobEventData, callback?: (ack: boolean) => void) => {
    if (typeof callback === "function") callback(true);
    slog("info", "onNewTask", { jobId: (data as any)?.id, phase: (data as any)?.phase });
    callbacks.onNewTask(data);
  });

  socket.on(SocketEvent.ON_EVALUATE, (data: AcpJobEventData, callback?: (ack: boolean) => void) => {
    if (typeof callback === "function") callback(true);
    slog("info", "onEvaluate", { jobId: (data as any)?.id, phase: (data as any)?.phase });
    callbacks.onEvaluate?.(data);
  });

  socket.on("connect", () => {
    slog("info", "connected", { socketId: socket.id });
  });

  socket.on("disconnect", (reason) => {
    slog("warn", "disconnected", { reason });
  });

  socket.on("connect_error", (err) => {
    slog("error", "connect_error", { message: err?.message ?? String(err) });
  });

  // Reconnect lifecycle (socket.io Manager events)
  socket.io.on("reconnect_attempt", (attempt) => {
    slog("warn", "reconnect_attempt", { attempt });
  });
  socket.io.on("reconnect", (attempt) => {
    slog("info", "reconnected", { attempt });
  });
  socket.io.on("reconnect_error", (err) => {
    slog("warn", "reconnect_error", { message: err?.message ?? String(err) });
  });

  const disconnect = () => {
    try {
      socket.disconnect();
    } catch {
      // ignore
    }
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
