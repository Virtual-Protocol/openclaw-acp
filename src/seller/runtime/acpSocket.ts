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

/**
 * Connect to the ACP socket and start listening for seller events.
 * Returns a cleanup function that disconnects the socket.
 */
export function connectAcpSocket(opts: AcpSocketOptions): () => void {
  const { acpUrl, walletAddress, callbacks } = opts;

  const socket: Socket = io(acpUrl, {
    auth: { walletAddress },
    transports: ["websocket"],
  });

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
    console.log("[socket] Connected to ACP");
  });

  socket.on("disconnect", (reason) => {
    console.log(`[socket] Disconnected: ${reason}`);

    // "io server disconnect" = server forcibly closed the connection.
    // Socket.io will NOT auto-reconnect — we must explicitly reconnect.
    if (reason === "io server disconnect") {
      console.log("[socket] Server-initiated disconnect — forcing manual reconnect in 5s...");
      setTimeout(() => {
        console.log("[socket] Attempting manual reconnect...");
        socket.connect();
      }, 5_000);
    }
  });

  socket.on("connect_error", (err) => {
    console.error(`[socket] Connection error: ${err.message}`);
  });

  const disconnect = () => {
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
