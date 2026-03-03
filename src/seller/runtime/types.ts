// =============================================================================
// Minimal ACP types for the seller runtime.
// Standalone — no imports from @virtuals-protocol/acp-node.
// =============================================================================

/** Job lifecycle phases (mirrors AcpJobPhases from acp-node). */
export enum AcpJobPhase {
  REQUEST = 0,
  NEGOTIATION = 1,
  TRANSACTION = 2,
  EVALUATION = 3,
  COMPLETED = 4,
  REJECTED = 5,
  EXPIRED = 6,
}

/** Memo types attached to a job (mirrors MemoType from acp-node). */
export enum MemoType {
  MESSAGE = 0,
  CONTEXT_URL = 1,
  IMAGE_URL = 2,
  VOICE_URL = 3,
  OBJECT_URL = 4,
  TXHASH = 5,
  PAYABLE_REQUEST = 6,
  PAYABLE_TRANSFER = 7,
  PAYABLE_FEE = 8,
  PAYABLE_FEE_REQUEST = 9,
}

/** Shape of a single memo as received from the ACP socket/API. */
export interface AcpMemoData {
  id: number;
  memoType: MemoType;
  content: string;
  nextPhase: AcpJobPhase;
  expiry?: string | null;
  createdAt?: string;
  type?: string;
}

/** Shape of the job payload delivered via socket `onNewTask` / `onEvaluate`. */
export interface AcpJobEventData {
  id: number;
  phase: AcpJobPhase;
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
  price: number;
  memos: AcpMemoData[];
  context: Record<string, any>;
  createdAt?: string;
  /** The memo id the seller is expected to sign (if any). */
  memoToSign?: number;
}

/** Socket event names used by the ACP backend. */
export enum SocketEvent {
  ROOM_JOINED = "roomJoined",
  ON_NEW_TASK = "onNewTask",
  ON_EVALUATE = "onEvaluate",
}
