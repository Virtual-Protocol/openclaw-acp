// =============================================================================
// ACP API wrappers for job offerings and resources.
// =============================================================================

import client from "./client.js";

export interface PriceV2 {
  type: "fixed" | "percentage";
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
  subscriptionTiers?: string[];
}

export interface Resource {
  name: string;
  description: string;
  url: string;
  params?: Record<string, any>;
}

export interface AgentData {
  name: string;
  tokenAddress: string;
  resources: Resource[];
  offerings: JobOfferingData[];
}

export interface CreateJobOfferingResponse {
  success: boolean;
  data?: unknown;
}

export interface PaymentUrlResponse {
  url: string;
}

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

export async function createSubscription(tier: {
  name: string;
  price: number;
  duration: number;
}): Promise<{ success: boolean; data?: { id: number; name: string; price: number; duration: number } }> {
  try {
    const { data } = await client.post(`/acp/subscriptions`, tier);
    return { success: true, data: data.data };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`ACP createSubscription failed: ${msg}`);
    return { success: false };
  }
}

export async function deleteSubscription(
  name: string
): Promise<{ success: boolean }> {
  try {
    await client.delete(`/acp/subscriptions/${encodeURIComponent(name)}`);
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`ACP deleteSubscription failed: ${msg}`);
    return { success: false };
  }
}

export async function getPaymentUrl(): Promise<{
  success: boolean;
  url?: string;
}> {
  try {
    const { data } = await client.get<{ data: PaymentUrlResponse }>(
      "/acp/topup"
    );
    return { success: true, url: data.data.url };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`ACP getPaymentUrl failed: ${msg}`);
    return { success: false };
  }
}
