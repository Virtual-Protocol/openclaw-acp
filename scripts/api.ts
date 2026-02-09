// ---------------------------------------------------------------------------
// Types (mirrors the minimal subset we need for job offerings)
// ---------------------------------------------------------------------------

import client from "./client";

export interface PriceV2 {
  type: "fixed";
  value: number;
}

export interface JobOfferingData {
  name: string;
  description: string;
  priceV2: PriceV2;
  slaMinutes: number;
  requiredFunds: boolean;
  requirement: Record<string, any>;
  deliverable: string;
  resources?: Resource[];
}

export interface Resource {
  name: string;
  description: string;
  url: string;
  params?: Record<string, any>;
}

export interface CreateJobOfferingResponse {
  success: boolean;
  /** Raw response body from the ACP API (shape may evolve). */
  data?: unknown;
}

export interface AgentData {
  name: string;
  tokenAddress: string;
  resources: Resource[];
  offerings: JobOfferingData[];
}

// ---------------------------------------------------------------------------
// ACP job offerings (register / delist)
// ---------------------------------------------------------------------------

/**
 * Register a job offering on ACP by calling POST /acp/job-offerings.
 *
 * @param apiKey   - The x-api-key for authenticating with the ACP service.
 * @param offering - The job offering payload.
 */
export async function createJobOffering(
  offering: JobOfferingData
): Promise<{ success: boolean; data?: AgentData }> {
  try {
    const { data } = await client.post(`/acp/job-offerings`, {
      data: offering,
    });
    return { success: true, data };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`ACP createJobOffering failed: ${msg}`);
    return { success: false };
  }
}

export async function deleteJobOffering(
  offeringName: string
): Promise<{ success: boolean }> {
  try {
    await client.delete(
      `/acp/job-offerings/${encodeURIComponent(offeringName)}`
    );
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`ACP deleteJobOffering failed: ${msg}`);
    return { success: false };
  }
}

export async function upsertResourceApi(
  resource: Resource
): Promise<{ success: boolean; data?: AgentData }> {
  try {
    const { data } = await client.post(`/acp/resources`, {
      data: resource,
    });
    return { success: true, data };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`ACP upsertResource failed: ${msg}`);
    return { success: false };
  }
}

export async function deleteResourceApi(
  resourceName: string
): Promise<{ success: boolean }> {
  try {
    await client.delete(`/acp/resources/${encodeURIComponent(resourceName)}`);
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`ACP deleteResource failed: ${msg}`);
    return { success: false };
  }
}
