// =============================================================================
// Subscription tier management commands.
//
// Usage:
//   acp sub list
//   acp sub create <name> <price> <duration>
//   acp sub inspect <name>
//   acp sub remove <name>
// =============================================================================

import { getMyAgentInfo } from "../lib/wallet.js";
import { createSubscription, deleteSubscription } from "../lib/api.js";

/**
 * List all subscription tiers for the active agent.
 */
export async function list(): Promise<void> {
  const agent = await getMyAgentInfo();
  const tiers = agent.subscriptions ?? [];

  if (tiers.length === 0) {
    console.log("No subscription tiers configured.");
    console.log('Run `acp sub create <name> <price> <duration>` to create one.');
    return;
  }

  console.log(`Subscription tiers for "${agent.name}":\n`);
  for (const tier of tiers) {
    console.log(`  ${tier.name}`);
    console.log(`    ID:       ${tier.id}`);
    console.log(`    Price:    ${tier.price} USDC`);
    console.log(`    Duration: ${tier.duration} days`);
    console.log();
  }
}

/**
 * Create a new subscription tier.
 */
export async function create(
  name: string | undefined,
  price: number | undefined,
  duration: number | undefined
): Promise<void> {
  if (!name) {
    console.error("Error: Missing subscription tier name.");
    console.error("Usage: acp sub create <name> <price> <duration>");
    process.exit(1);
  }
  if (price == null || isNaN(price) || price <= 0) {
    console.error("Error: Price must be a positive number.");
    console.error("Usage: acp sub create <name> <price> <duration>");
    process.exit(1);
  }
  if (duration == null || isNaN(duration) || duration <= 0) {
    console.error("Error: Duration must be a positive number (days).");
    console.error("Usage: acp sub create <name> <price> <duration>");
    process.exit(1);
  }

  const result = await createSubscription({ name, price, duration });

  if (!result.success) {
    console.error("Failed to create subscription tier.");
    process.exit(1);
  }

  console.log(`Subscription tier "${name}" created.`);
  console.log(`  Price:    ${price} USDC`);
  console.log(`  Duration: ${duration} days`);
}

/**
 * Inspect a subscription tier by name.
 */
export async function inspect(name: string | undefined): Promise<void> {
  if (!name) {
    console.error("Error: Missing subscription tier name.");
    console.error("Usage: acp sub inspect <name>");
    process.exit(1);
  }

  const agent = await getMyAgentInfo();
  const tiers = agent.subscriptions ?? [];
  const tier = tiers.find((t) => t.name === name);

  if (!tier) {
    console.error(`Subscription tier "${name}" not found.`);
    const available = tiers.map((t) => t.name).join(", ");
    if (available) {
      console.error(`Available tiers: ${available}`);
    }
    process.exit(1);
  }

  console.log(`Subscription tier: ${tier.name}\n`);
  console.log(`  ID:       ${tier.id}`);
  console.log(`  Price:    ${tier.price} USDC`);
  console.log(`  Duration: ${tier.duration} days`);
}

/**
 * Remove a subscription tier by name.
 */
export async function remove(name: string | undefined): Promise<void> {
  if (!name) {
    console.error("Error: Missing subscription tier name.");
    console.error("Usage: acp sub remove <name>");
    process.exit(1);
  }

  const result = await deleteSubscription(name);

  if (!result.success) {
    console.error(`Failed to remove subscription tier "${name}".`);
    process.exit(1);
  }

  console.log(`Subscription tier "${name}" removed.`);
}
