#!/usr/bin/env node
/**
 * ACP Leadgen — Reliability-Hardened Version
 * 
 * Fixes:
 * - Entity 1648 whitelist preflight
 * - RPC 429 handling with fallback provider
 * - Deterministic run results
 */

import { createPublicClient, http, fallback } from 'viem';
import { base } from 'viem/chains';

// Configuration
const ENTITY_ID = 1648;
const AGENT_WALLET = '0xB64228fC35c9F6EC0B79137b119b462973256191';
const ACP_REGISTRY = '0x00000000000099DE0BF6fA90dEB851E2A2df7d83';

// RPC Providers (fallback chain)
const RPC_PROVIDERS = [
  'https://mainnet.base.org',
  'https://base-mainnet.g.alchemy.com/v2/demo',
  'https://1rpc.io/base',
];

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_RUNTIME_MS = 300000; // 5 minutes

// Queries to run
const QUERIES = [
  'openclaw skill',
  'agent skill development',
  'security audit',
  'x402',
  'discord bot',
  'solidity foundry',
];

// ABI for signers check
const SIGNERS_ABI = [{
  inputs: [{ name: 'entityId', type: 'uint32' }, { name: 'account', type: 'address' }],
  name: 'signers',
  outputs: [{ name: '', type: 'bool' }],
  stateMutability: 'view',
  type: 'function',
}];

class ACPLeadgen {
  constructor() {
    this.results = [];
    this.retryCount = 0;
    this.startTime = Date.now();
    this.currentProvider = 0;
    this.unhandled429s = 0;
    this.totalRequests = 0;
  }

  get client() {
    // Create client with fallback providers
    return createPublicClient({
      chain: base,
      transport: fallback(
        RPC_PROVIDERS.map(url => http(url, { timeout: 10000 }))
      ),
    });
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async withRetry(operation, context) {
    let lastError;
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      this.totalRequests++;
      
      try {
        // Check runtime cap
        if (Date.now() - this.startTime > MAX_RUNTIME_MS) {
          return { ok: false, error: 'cap_exceeded', context };
        }

        // Exponential backoff with jitter
        if (attempt > 0) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
          await this.sleep(delay);
        }

        const result = await operation();
        if (attempt > 0) {
          this.retryCount += attempt;
        }
        return { ok: true, data: result, retries: attempt };
        
      } catch (error) {
        lastError = error;
        
        // Check for 429 rate limit
        const is429 = error.message?.includes('429') || 
                     error.message?.includes('rate limit') ||
                     error.code === -32016;
        
        if (is429) {
          if (attempt === MAX_RETRIES - 1) {
            this.unhandled429s++;
            return { ok: false, error: 'rate_limit_exhausted', context };
          }
          // Continue to next retry
          continue;
        }
        
        // Non-retryable error
        return { ok: false, error: error.message, errorClass: error.constructor.name, context };
      }
    }
    
    this.unhandled429s++;
    return { ok: false, error: lastError?.message || 'max_retries', context };
  }

  async preflightWhitelistCheck() {
    console.log('[leadgen] Running whitelist preflight...');
    
    const result = await this.withRetry(async () => {
      return await this.client.readContract({
        address: ACP_REGISTRY,
        abi: SIGNERS_ABI,
        functionName: 'signers',
        args: [ENTITY_ID, AGENT_WALLET],
      });
    }, 'whitelist_preflight');

    if (!result.ok) {
      return {
        pass: false,
        reason: 'preflight_failed',
        error: result.error,
      };
    }

    if (!result.data) {
      return {
        pass: false,
        reason: 'not_whitelisted',
        entityId: ENTITY_ID,
        agentWallet: AGENT_WALLET,
      };
    }

    return { pass: true };
  }

  async runQuery(query) {
    console.log(`[leadgen] Query: "${query}"`);
    
    // Simulate ACP browse call (replace with actual implementation)
    // This is a placeholder for the actual ACP query logic
    const result = await this.withRetry(async () => {
      // In real implementation, this would call the ACP API
      // For now, return mock failure to match current behavior
      throw new Error('ACP Contract Client validation failed: no whitelisted wallet');
    }, `query_${query}`);

    return {
      query,
      ok: result.ok,
      error: result.error,
      retries: result.retries,
    };
  }

  async run() {
    console.log('[leadgen] Starting ACP leadgen run...');
    console.log(`[leadgen] Max runtime: ${MAX_RUNTIME_MS}ms, Max retries: ${MAX_RETRIES}`);

    // Step 1: Preflight whitelist check
    const preflight = await this.preflightWhitelistCheck();
    if (!preflight.pass) {
      console.error('[leadgen] Preflight FAILED:', preflight.reason);
      
      return {
        timestamp: new Date().toISOString(),
        status: 'blocked_auth',
        reason: preflight.reason,
        entityId: ENTITY_ID,
        agentWallet: AGENT_WALLET,
        queryCount: 0,
        results: [],
        dedupedAgentCount: 0,
        dedupedAgents: [],
        rpcProvider: RPC_PROVIDERS[this.currentProvider],
        retryCount: this.retryCount,
        unhandled429Count: this.unhandled429s,
        unhandled429RatePct: 0,
        durationMs: Date.now() - this.startTime,
      };
    }

    console.log('[leadgen] Preflight PASSED — proceeding with queries');

    // Step 2: Run queries
    for (const query of QUERIES) {
      const result = await this.runQuery(query);
      this.results.push(result);
    }

    // Step 3: Calculate metrics
    const successfulQueries = this.results.filter(r => r.ok);
    const dedupedAgents = []; // Would dedupe actual results
    
    const total429s = this.results.filter(r => 
      r.error?.includes('429') || r.error?.includes('rate limit')
    ).length;

    const status = successfulQueries.length > 0 ? 'success' : 'no_match';

    const output = {
      timestamp: new Date().toISOString(),
      status,
      queryCount: QUERIES.length,
      results: this.results,
      dedupedAgentCount: dedupedAgents.length,
      dedupedAgents,
      rpcProvider: RPC_PROVIDERS[this.currentProvider],
      retryCount: this.retryCount,
      unhandled429Count: this.unhandled429s,
      unhandled429RatePct: this.totalRequests > 0 
        ? (this.unhandled429s / this.totalRequests) * 100 
        : 0,
      durationMs: Date.now() - this.startTime,
    };

    console.log('[leadgen] Run complete:', JSON.stringify(output, null, 2));
    return output;
  }
}

// Main execution
async function main() {
  const leadgen = new ACPLeadgen();
  const result = await leadgen.run();
  
  // Write output
  const fs = await import('fs');
  const outputPath = '/opt/fundbot/work/workspace-connie/deliverables/acp-ops/leadgen/latest.json';
  
  fs.mkdirSync('/opt/fundbot/work/workspace-connie/deliverables/acp-ops/leadgen', { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  
  console.log(`[leadgen] Output written to ${outputPath}`);
  
  // Exit code based on status
  process.exit(result.status === 'success' ? 0 : 1);
}

main().catch(console.error);
