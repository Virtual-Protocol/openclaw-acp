// =============================================================================
// acp job create <wallet> <offering> [--requirements '{}'] [--subscription '<subscriptionTier>']
// acp job status <jobId>
// acp job active
// acp job completed
// =============================================================================

import client from "../lib/client.js";
import { formatPrice } from "../lib/config.js";
import * as output from "../lib/output.js";
import { getBountyByJobId } from "../lib/bounty.js";

export async function create(
  agentWalletAddress: string,
  jobOfferingName: string,
  serviceRequirements: Record<string, unknown>,
  preferredSubscriptionTier?: string,
): Promise<void> {
  if (!agentWalletAddress || !jobOfferingName) {
    output.fatal(
      "Usage: acp job create <agentWalletAddress> <jobOfferingName> [--requirements '<json>'] [--subscription '<subscriptionTier>']"
    );
  }

  const subscriptionRequired = preferredSubscriptionTier != null;

  if (subscriptionRequired) {
    output.log(`\n  Subscription tier: ${preferredSubscriptionTier}`);
  }

  try {
    const job = await client.post<{ data: { jobId: number } }>("/acp/jobs", {
      providerWalletAddress: agentWalletAddress,
      jobOfferingName,
      serviceRequirements,
      ...(preferredSubscriptionTier != null && { preferredSubscriptionTier }),
    });

    output.output(job.data, (data) => {
      output.heading("Job Created");
      output.field("Job ID", data.data?.jobId ?? data.jobId);
      if (subscriptionRequired) {
        output.field("Subscription Tier", preferredSubscriptionTier);
      }
      output.log(
        "\n  Job submitted. Use `acp job status <jobId>` to check progress.\n"
      );
    });
  } catch (e) {
    output.fatal(
      `Failed to create job: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export async function status(jobId: string): Promise<void> {
  if (!jobId) {
    output.fatal("Usage: acp job status <jobId>");
  }

  try {
    const job = await client.get(`/acp/jobs/${jobId}`);

    if (!job?.data?.data) {
      output.fatal(`Job not found: ${jobId}`);
    }

    const data = job.data.data;

    const memoHistory = (data.memos || []).map(
      (memo: {
        nextPhase: string;
        content: string;
        createdAt: string;
        status: string;
      }) => ({
        nextPhase: memo.nextPhase,
        content: memo.content,
        createdAt: memo.createdAt,
        status: memo.status,
      })
    );

    const result = {
      jobId: data.id,
      phase: data.phase,
      providerName: data.providerName ?? null,
      providerWalletAddress: data.providerAddress ?? null,
      clientName: data.clientName ?? null,
      clientWalletAddress: data.clientAddress ?? null,
      deliverable: data.deliverable,
      memoHistory,
    };
    const linkedBountyId = getBountyByJobId(String(result.jobId))?.bountyId;

    output.output(result, (r) => {
      output.heading(`Job ${r.jobId}`);
      output.field("Phase", r.phase);
      output.field("Client", r.clientName || "-");
      output.field("Client Wallet", r.clientWalletAddress || "-");
      output.field("Provider", r.providerName || "-");
      output.field("Provider Wallet", r.providerWalletAddress || "-");
      if (r.deliverable) {
        output.log(`\n  Deliverable:\n    ${r.deliverable}`);
      }
      if (r.memoHistory.length > 0) {
        output.log("\n  History:");
        for (const m of r.memoHistory) {
          output.log(`    [${m.nextPhase}] ${m.content} (${m.createdAt})`);
        }
      }
      if (linkedBountyId) {
        output.log(
          `\n  This job is linked to bounty ${linkedBountyId}.`
        );
        output.log(
          `  Run \`acp bounty status ${linkedBountyId}\` to sync bounty status.\n`
        );
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(
      `Failed to get job status: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

type JobListItem = {
  id: number | string;
  phase?: unknown;
  price?: unknown;
  priceType?: unknown;
  clientAddress?: unknown;
  providerAddress?: unknown;
  name?: unknown;
  deliverable?: unknown;
};

export type JobListOptions = {
  page?: number;
  pageSize?: number;
};

export async function active(options: JobListOptions = {}): Promise<void> {
  try {
    const params: Record<string, number> = {};
    if (options.page != null) params.page = options.page;
    if (options.pageSize != null) params.pageSize = options.pageSize;
    const res = await client.get<{ data: JobListItem[] }>("/acp/jobs/active", {
      params,
    });
    const jobs = res.data.data;

    output.output({ jobs }, ({ jobs: list }) => {
      output.heading("Active Jobs");
      if (list.length === 0) {
        output.log("  No active jobs.\n");
        return;
      }
      for (const j of list) {
        output.field("Job ID", j.id);
        if (j.phase) output.field("Phase", j.phase);
        if (j.name) output.field("Name", j.name);
        if (j.price != null)
          output.field("Price", formatPrice(j.price, j.priceType));
        if (j.clientAddress) output.field("Client", j.clientAddress);
        if (j.providerAddress) output.field("Provider", j.providerAddress);
        if (j.deliverable) output.field("Deliverable", j.deliverable);
        output.log("");
      }
    });
  } catch (e) {
    output.fatal(
      `Failed to get active jobs: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export async function completed(options: JobListOptions = {}): Promise<void> {
  try {
    const params: Record<string, number> = {};
    if (options.page != null) params.page = options.page;
    if (options.pageSize != null) params.pageSize = options.pageSize;
    const res = await client.get<{ data: JobListItem[] }>(
      "/acp/jobs/completed",
      {
        params,
      }
    );
    const jobs = res.data.data;

    output.output({ jobs }, ({ jobs: list }) => {
      output.heading("Completed Jobs");
      if (list.length === 0) {
        output.log("  No completed jobs.\n");
        return;
      }
      for (const j of list) {
        output.field("Job ID", j.id);
        if (j.name) output.field("Name", j.name);
        if (j.price != null)
          output.field("Price", formatPrice(j.price, j.priceType));
        if (j.clientAddress) output.field("Client", j.clientAddress);
        if (j.providerAddress) output.field("Provider", j.providerAddress);
        if (j.deliverable) output.field("Deliverable", j.deliverable);
        output.log("");
      }
    });
  } catch (e) {
    output.fatal(
      `Failed to get completed jobs: ${e instanceof Error ? e.message : String(e)
      }`
    );
  }
}
