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

/** Shape of a single memo as received from the ACP socket/API.
 *
 * NOTE: The ACP backend has returned both numeric and string phase values.
 * Keep this tolerant to schema drift.
 */
export interface AcpMemoData {
  id: number;
  /** Older payloads include memoType; newer ones may omit it. */
  memoType?: MemoType | number | string;
  content: string;
  /** Can be numeric enum value (0..6) or string ("NEGOTIATION"). */
  nextPhase: AcpJobPhase | number | string;
  status?: string;
  signedReason?: string | null;
  expiry?: string | null;
  createdAt?: string;
  type?: string;
}

/** Shape of the job payload delivered via socket `onNewTask` / `onEvaluate`.
 *
 * NOTE: `phase` may arrive as a string (e.g. "NEGOTIATION") depending on backend.
 */
export interface AcpJobEventData {
  id: number;
  phase: AcpJobPhase | number | string;
  clientAddress: string;
  providerAddress: string;
  evaluatorAddress: string;
  price: number;
  memos: AcpMemoData[];
  context?: Record<string, any>;
  createdAt?: string;
  name?: string;
  deliverable?: unknown;
  /** The memo id the seller is expected to sign (if any). */
  memoToSign?: number | string;
}

/** Socket event names used by the ACP backend. */
export enum SocketEvent {
  ROOM_JOINED = "roomJoined",
  ON_NEW_TASK = "onNewTask",
  ON_EVALUATE = "onEvaluate",
}
