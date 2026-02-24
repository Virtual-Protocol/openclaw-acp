// =============================================================================
// Bounty API + local active-bounty state management.
// =============================================================================

import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { ROOT, loadApiKey } from "./config.js";

export type BountyStatus =
  | "open"
  | "pending_match"
  | "claimed"
  | "fulfilled"
  | "expired"
  | "rejected";

export interface BountyCreateInput {
  poster_email?: string;
  title: string;
  description: string;
  budget: number;
  category: string;
  tags: string;
}

export interface BountyMatchCandidate {
  id: number;
  name?: string;
  walletAddress?: string;
  offeringName?: string;
  [key: string]: unknown;
}

export interface BountyMatchStatusResponse {
  status: BountyStatus | string;
  candidates: BountyMatchCandidate[];
  acp_job_id?: string | number | null;
  [key: string]: unknown;
}

export interface ActiveBounty {
  bountyId: string;
  createdAt: string;
  status: BountyStatus | string;
  title: string;
  description: string;
  budget: number;
  category: string;
  tags: string;
  posterName: string;
  posterSecret: string;
  selectedCandidateId?: number;
  acpJobId?: string;
  /** Set to true after the agent has been notified about pending_match candidates. */
  notifiedPendingMatch?: boolean;
  /** Channel where this bounty was created (e.g. "telegram", "webchat") for routing notifications. */
  sourceChannel?: string;
}

interface ActiveBountiesFile {
  bounties: ActiveBounty[];
}

const api = axios.create({
  baseURL: process.env.ACP_BOUNTY_API_URL || "https://bounty.virtuals.io/api/v1",
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  loadApiKey();
  if (process.env.LITE_AGENT_API_KEY) {
    config.headers["x-api-key"] = process.env.LITE_AGENT_API_KEY;
  }
  return config;
});

export const BOUNTY_STATE_PATH = path.resolve(ROOT, "active-bounties.json");

function extractData<T>(raw: any): T {
  if (raw && typeof raw === "object" && "data" in raw) {
    return raw.data as T;
  }
  return raw as T;
}

function ensureParent(filePath: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}

function readState(): ActiveBountiesFile {
  if (!fs.existsSync(BOUNTY_STATE_PATH)) return { bounties: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(BOUNTY_STATE_PATH, "utf-8"));
    if (Array.isArray(raw?.bounties)) {
      return { bounties: raw.bounties as ActiveBounty[] };
    }
  } catch {
    return { bounties: [] };
  }
  return { bounties: [] };
}

function writeState(next: ActiveBountiesFile): void {
  ensureParent(BOUNTY_STATE_PATH);
  fs.writeFileSync(BOUNTY_STATE_PATH, JSON.stringify(next, null, 2) + "\n");
}

export function listActiveBounties(): ActiveBounty[] {
  return readState().bounties;
}

export function getActiveBounty(bountyId: string): ActiveBounty | undefined {
  return readState().bounties.find((b) => b.bountyId === bountyId);
}

export function getBountyByJobId(jobId: string): ActiveBounty | undefined {
  return readState().bounties.find((b) => b.acpJobId === jobId);
}

export function saveActiveBounty(bounty: ActiveBounty): void {
  const state = readState();
  const idx = state.bounties.findIndex((b) => b.bountyId === bounty.bountyId);
  if (idx >= 0) {
    state.bounties[idx] = bounty;
  } else {
    state.bounties.push(bounty);
  }
  writeState(state);
}

export function removeActiveBounty(bountyId: string): void {
  const state = readState();
  state.bounties = state.bounties.filter((b) => b.bountyId !== bountyId);
  writeState(state);
}

export async function createBounty(
  input: BountyCreateInput
): Promise<{ bountyId: string; posterSecret: string; raw: unknown }> {
  const res = await api.post("/bounties/", input);
  const body = extractData<any>(res.data);

  const bountyNode = body?.bounty && typeof body.bounty === "object" ? body.bounty : body;

  const bountyId =
    bountyNode?.id ??
    bountyNode?.bounty_id ??
    bountyNode?.bountyId ??
    body?.id ??
    body?.bounty_id ??
    body?.bountyId;
  const posterSecret =
    body?.poster_secret ??
    body?.posterSecret ??
    body?.data?.poster_secret ??
    body?.data?.posterSecret;

  if (!bountyId || !posterSecret) {
    throw new Error("Invalid create bounty response: missing id or poster_secret");
  }

  return {
    bountyId: String(bountyId),
    posterSecret: String(posterSecret),
    raw: body,
  };
}

export async function getBountyDetails(bountyId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`/bounties/${encodeURIComponent(bountyId)}`);
  return extractData<Record<string, unknown>>(res.data);
}

export async function getMatchStatus(bountyId: string): Promise<BountyMatchStatusResponse> {
  const res = await api.get(`/bounties/${encodeURIComponent(bountyId)}/match-status`);
  const body = extractData<any>(res.data);

  return {
    ...body,
    status: String(body?.status ?? ""),
    candidates: Array.isArray(body?.candidates) ? body.candidates : [],
  };
}

export async function confirmMatch(params: {
  bountyId: string;
  posterSecret: string;
  candidateId: number;
  acpJobId: string;
}): Promise<unknown> {
  const { bountyId, posterSecret, candidateId, acpJobId } = params;
  const res = await api.post(`/bounties/${encodeURIComponent(bountyId)}/confirm-match`, {
    poster_secret: posterSecret,
    candidate_id: candidateId,
    acp_job_id: acpJobId,
  });
  return extractData<unknown>(res.data);
}

export interface BountyUpdateInput {
  poster_secret: string;
  title?: string;
  description?: string;
  budget?: number;
  tags?: string;
}

export async function updateBounty(bountyId: string, input: BountyUpdateInput): Promise<unknown> {
  const res = await api.put(`/bounties/${encodeURIComponent(bountyId)}`, input);
  return extractData<unknown>(res.data);
}

export async function rejectCandidates(params: {
  bountyId: string;
  posterSecret: string;
}): Promise<unknown> {
  const { bountyId, posterSecret } = params;
  const res = await api.post(`/bounties/${encodeURIComponent(bountyId)}/reject-candidates`, {
    poster_secret: posterSecret,
  });
  return extractData<unknown>(res.data);
}

export async function syncBountyJobStatus(params: {
  bountyId: string;
  posterSecret: string;
}): Promise<unknown> {
  const { bountyId, posterSecret } = params;
  const res = await api.post(`/bounties/${encodeURIComponent(bountyId)}/job-status`, {
    poster_secret: posterSecret,
  });
  return extractData<unknown>(res.data);
}
