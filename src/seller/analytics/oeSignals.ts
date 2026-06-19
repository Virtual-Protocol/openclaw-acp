import { createPublicClient, http, parseAbi, fallback } from "viem";
import { base } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

type AgentStats = {
  agent: string;
  roundsAsCreator: number;
  roundsAsJoiner: number;
  creatorOddCount: number;
  creatorEvenCount: number;
  joinGuessOddCount: number;
  joinGuessEvenCount: number;
  creatorRevealSuccess: number;
  creatorRevealTimeout: number;
  byOpponent: Record<
    string,
    { creatorOdd: number; creatorEven: number; joinOdd: number; joinEven: number; total: number }
  >;
  recentCreatorParity: Array<"ODD" | "EVEN">;
};

type PackageId =
  | "oe_bias_basic"
  | "oe_bias_delta"
  | "oe_regime_watch"
  | "oe_matchup_edge"
  | "oe_reveal_reliability"
  | "oe_signal_pro"
  | "oe_action_reco"
  | "oe_meta_adapt"
  | "oe_risk_guard"
  | "oe_full_dossier"
  | "oe_alpha_feed_24h";

const GAME_ABI = parseAbi([
  "function nextRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (address,bytes32,uint256,address,uint8,uint8,uint64,uint64)",
  "event RoundSettled(uint256 indexed roundId, address indexed winner, uint256 payout, uint256 fee)",
  "event RoundTimeoutSettled(uint256 indexed roundId, address indexed joiner, uint256 payout, uint256 fee)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

const cache: { at: number; key: string; payload: any } = { at: 0, key: "", payload: null };

// Incremental log cache — avoids re-scanning old blocks on every warm cycle.
const _logCache: {
  settledLogs: any[];
  timeoutLogs: any[];
  scannedToBlock: bigint;
} = { settledLogs: [], timeoutLogs: [], scannedToBlock: 0n };

// In-flight promise deduplication: if a scan is already running, subsequent
// callers wait for the same promise instead of starting a parallel scan.
const _inflight: Map<string, Promise<any>> = new Map();

// -- Cache warming --------------------------------------------------------
// Proactively refreshes the stats cache every ~45 s so that when a signal
// job arrives the data is already hot and delivery finishes well within the
// ~180 s ACP transaction window.
let _warmingInterval: ReturnType<typeof setInterval> | null = null;

export async function warmSignalCache(): Promise<void> {
  const contractAddress = (process.env.CONTRACT_ADDRESS ?? "") as `0x${string}`;
  const rpcUrl = process.env.RPC_URL ?? process.env.BASE_RPC ?? "https://mainnet.base.org";
  if (!contractAddress) {
    console.warn("[oeSignals] CONTRACT_ADDRESS not set — cannot warm cache");
    return;
  }
  try {
    console.log("[oeSignals] Warming signal cache...");
    await scanStats({ contractAddress, rpcUrl, maxRounds: 700 });
    console.log("[oeSignals] Signal cache warmed.");
  } catch (err) {
    console.error("[oeSignals] Cache warm failed:", err);
  }
}

export function startSignalCacheWarmer(intervalMs = 45_000): void {
  if (_warmingInterval) return; // already running
  // Fire immediately (non-blocking), then on interval
  warmSignalCache().catch(() => {});
  _warmingInterval = setInterval(() => {
    warmSignalCache().catch(() => {});
  }, intervalMs);
  _warmingInterval.unref?.(); // don't keep the process alive for this alone
  console.log(`[oeSignals] Cache warmer started (interval=${intervalMs}ms).`);
}

function norm(a?: string): string {
  return String(a || "").toLowerCase();
}

function initStats(agent: string): AgentStats {
  return {
    agent,
    roundsAsCreator: 0,
    roundsAsJoiner: 0,
    creatorOddCount: 0,
    creatorEvenCount: 0,
    joinGuessOddCount: 0,
    joinGuessEvenCount: 0,
    creatorRevealSuccess: 0,
    creatorRevealTimeout: 0,
    byOpponent: {},
    recentCreatorParity: [],
  };
}

function ratio(n: number, d: number): number {
  if (!d) return 0.5;
  return n / d;
}

function confidence(samples: number, skew: number): number {
  // samples drive confidence up; extreme skew with low sample is penalized
  const sampleScore = Math.min(0.92, 0.28 + Math.log2(Math.max(2, samples)) * 0.11);
  const skewPenalty = samples < 15 ? Math.min(0.12, Math.abs(skew - 0.5) * 0.25) : 0;
  const c = Math.max(0.15, Math.min(0.95, sampleScore - skewPenalty));
  return Number(c.toFixed(3));
}

function actionFromOddRate(oddRate: number, high = 0.52, low = 0.48): "ODD" | "EVEN" | "NO_EDGE" {
  if (oddRate >= high) return "ODD";
  if (oddRate <= low) return "EVEN";
  return "NO_EDGE";
}

function actionFromDelta(delta: number, threshold = 0.04): "ODD" | "EVEN" | "NO_EDGE" {
  if (delta >= threshold) return "ODD";
  if (delta <= -threshold) return "EVEN";
  return "NO_EDGE";
}

function getRecentStreak(parities: Array<"ODD" | "EVEN">, lookback = 5) {
  const recent = parities.slice(-lookback);
  const odd = recent.filter((x) => x === "ODD").length;
  const even = recent.length - odd;
  const tail = recent.slice(-3);
  const tailAllSame = tail.length >= 3 && tail.every((x) => x === tail[0]);

  let action: "ODD" | "EVEN" | "NO_EDGE" = "NO_EDGE";
  if (recent.length >= 4) {
    if (odd >= 3)
      action = "ODD"; // 완화: 4→3 (5개 중 3개)
    else if (even >= 3) action = "EVEN";
  }
  if (action === "NO_EDGE" && tailAllSame) action = tail[0];

  return {
    lookback: recent.length,
    odd,
    even,
    tail: recent,
    action,
    confidence: recent.length ? Number((Math.max(odd, even) / recent.length).toFixed(3)) : 0,
  };
}

function majorityAction(candidates: Array<"ODD" | "EVEN" | "NO_EDGE">): "ODD" | "EVEN" | "NO_EDGE" {
  const odd = candidates.filter((x) => x === "ODD").length;
  const even = candidates.filter((x) => x === "EVEN").length;
  if (odd >= 2 && odd > even) return "ODD";
  if (even >= 2 && even > odd) return "EVEN";
  return "NO_EDGE";
}

function inferCreatorParity(joinGuessIsOdd: boolean, joinerWon: boolean): "ODD" | "EVEN" {
  if (joinerWon) return joinGuessIsOdd ? "ODD" : "EVEN";
  return joinGuessIsOdd ? "EVEN" : "ODD";
}

async function scanStats({
  contractAddress,
  rpcUrl,
  maxRounds = 600,
}: {
  contractAddress: `0x${string}`;
  rpcUrl: string;
  maxRounds?: number;
}) {
  const key = `${contractAddress}:${maxRounds}`;
  const now = Date.now();
  if (cache.payload && cache.key === key && now - cache.at < 60_000) {
    return cache.payload;
  }

  // If a scan for this key is already in-flight, wait for it instead of starting a parallel one.
  if (_inflight.has(key)) {
    return _inflight.get(key)!;
  }

  const scanPromise = _doScanStats({ contractAddress, rpcUrl, maxRounds, key });
  _inflight.set(key, scanPromise);
  scanPromise.finally(() => _inflight.delete(key));
  return scanPromise;
}

async function _doScanStats({
  contractAddress,
  rpcUrl,
  maxRounds = 600,
  key,
}: {
  contractAddress: `0x${string}`;
  rpcUrl: string;
  maxRounds?: number;
  key: string;
}) {
  const now = Date.now();

  const fallbackList = (
    process.env.RPC_FALLBACKS ?? "https://base-rpc.publicnode.com,https://1rpc.io/base"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rpcCandidates = Array.from(new Set([rpcUrl, ...fallbackList]));
  const transport =
    rpcCandidates.length === 1
      ? http(rpcCandidates[0], { timeout: 10_000, retryCount: 2, retryDelay: 250 })
      : fallback(
          rpcCandidates.map((url) => http(url, { timeout: 10_000, retryCount: 1, retryDelay: 250 }))
        );

  const client = createPublicClient({ chain: base, transport });
  const nextId = (await client.readContract({
    address: contractAddress,
    abi: GAME_ABI,
    functionName: "nextRoundId",
  })) as bigint;

  const end = Number(nextId) - 1;
  const start = Math.max(0, end - maxRounds + 1);

  const latestBlock = await client.getBlockNumber();
  const fromEnv = process.env.OE_SIGNAL_FROM_BLOCK
    ? BigInt(process.env.OE_SIGNAL_FROM_BLOCK)
    : latestBlock > 250000n
      ? latestBlock - 250000n
      : 0n;
  const CHUNK = 9000n;

  async function getLogsWithRetry(eventAbi: any, from: bigint, to: bigint, attempts = 3) {
    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await client.getLogs({
          address: contractAddress,
          event: eventAbi,
          fromBlock: from,
          toBlock: to,
        });
      } catch (err) {
        lastErr = err;
        if (i < attempts) {
          const waitMs = 250 * i;
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
    throw lastErr;
  }

  async function getLogsChunked(
    eventName: "RoundSettled" | "RoundTimeoutSettled",
    fromBlock: bigint
  ) {
    const eventAbi = GAME_ABI.find((x: any) => x.type === "event" && x.name === eventName) as any;
    const all: any[] = [];
    for (let from = fromBlock; from <= latestBlock; from += CHUNK) {
      const to = from + CHUNK - 1n > latestBlock ? latestBlock : from + CHUNK - 1n;
      const part = await getLogsWithRetry(eventAbi, from, to, 3);
      all.push(...(part as any[]));
    }
    return all;
  }

  // Incremental log scan: only fetch blocks we haven't seen yet.
  const incrementalFrom = _logCache.scannedToBlock > 0n ? _logCache.scannedToBlock + 1n : fromEnv;
  const newSettled = await getLogsChunked("RoundSettled", incrementalFrom);
  const newTimeout = await getLogsChunked("RoundTimeoutSettled", incrementalFrom);
  _logCache.settledLogs.push(...newSettled);
  _logCache.timeoutLogs.push(...newTimeout);
  _logCache.scannedToBlock = latestBlock;
  const settledLogs = _logCache.settledLogs;
  const timeoutLogs = _logCache.timeoutLogs;

  const settledWinnerByRound = new Map<number, string>();
  for (const l of settledLogs as any[]) {
    const rid = Number(l.args?.roundId);
    const winner = norm(l.args?.winner);
    if (Number.isFinite(rid) && winner) settledWinnerByRound.set(rid, winner);
  }
  const timeoutByRound = new Set<number>();
  for (const l of timeoutLogs as any[]) {
    const rid = Number(l.args?.roundId);
    if (Number.isFinite(rid)) timeoutByRound.add(rid);
  }

  const byAgent = new Map<string, AgentStats>();

  // Fetch all round data in parallel via multicall batches (50 rounds per call)
  const MCALL_BATCH = 50;
  const allRoundData = new Map<
    number,
    readonly [string, string, bigint, string, number, number, bigint, bigint]
  >();
  for (let batchStart = start; batchStart <= end; batchStart += MCALL_BATCH) {
    const batchEnd = Math.min(batchStart + MCALL_BATCH - 1, end);
    const calls = [];
    for (let i = batchStart; i <= batchEnd; i++) {
      calls.push({
        address: contractAddress,
        abi: GAME_ABI,
        functionName: "rounds" as const,
        args: [BigInt(i)] as const,
      });
    }
    try {
      const results = await client.multicall({ contracts: calls, allowFailure: true });
      for (let k = 0; k < results.length; k++) {
        const res = results[k];
        if (res.status === "success") {
          allRoundData.set(batchStart + k, res.result as any);
        }
      }
    } catch {
      // fall back to sequential on multicall failure
      for (let i = batchStart; i <= batchEnd; i++) {
        try {
          const r = (await client.readContract({
            address: contractAddress,
            abi: GAME_ABI,
            functionName: "rounds",
            args: [BigInt(i)],
          })) as any;
          allRoundData.set(i, r);
        } catch {
          /* skip */
        }
      }
    }
  }

  for (let i = start; i <= end; i++) {
    const r = allRoundData.get(i);
    if (!r) continue;

    const creator = norm(r[0]);
    const joiner = norm(r[3]);
    const guess = Number(r[4]); // 0 ODD, 1 EVEN
    const state = Number(r[5]); // 2 SETTLED expected

    if (!creator || creator === norm(ZERO)) continue;

    if (!byAgent.has(creator)) byAgent.set(creator, initStats(creator));
    const c = byAgent.get(creator)!;
    c.roundsAsCreator += 1;

    if (joiner && joiner !== norm(ZERO)) {
      if (!byAgent.has(joiner)) byAgent.set(joiner, initStats(joiner));
      const j = byAgent.get(joiner)!;
      j.roundsAsJoiner += 1;
      if (guess === 0) j.joinGuessOddCount += 1;
      else j.joinGuessEvenCount += 1;

      const opp = j.byOpponent[creator] || {
        creatorOdd: 0,
        creatorEven: 0,
        joinOdd: 0,
        joinEven: 0,
        total: 0,
      };
      if (guess === 0) opp.joinOdd += 1;
      else opp.joinEven += 1;
      opp.total += 1;
      j.byOpponent[creator] = opp;
    }

    if (state === 2 && joiner && joiner !== norm(ZERO)) {
      const timeout = timeoutByRound.has(i);
      if (timeout) {
        c.creatorRevealTimeout += 1;
      } else {
        c.creatorRevealSuccess += 1;
      }

      const winner = settledWinnerByRound.get(i);
      if (winner) {
        const joinerWon = winner === joiner;
        const creatorParity = inferCreatorParity(guess === 0, joinerWon);
        if (creatorParity === "ODD") c.creatorOddCount += 1;
        else c.creatorEvenCount += 1;
        c.recentCreatorParity.push(creatorParity);

        const cOpp = c.byOpponent[joiner] || {
          creatorOdd: 0,
          creatorEven: 0,
          joinOdd: 0,
          joinEven: 0,
          total: 0,
        };
        if (creatorParity === "ODD") cOpp.creatorOdd += 1;
        else cOpp.creatorEven += 1;
        cOpp.total += 1;
        c.byOpponent[joiner] = cOpp;
      }
    }
  }

  const payload = {
    byAgent,
    scannedRounds: end >= start ? end - start + 1 : 0,
    updatedAt: new Date().toISOString(),
  };
  cache.at = now;
  cache.key = key;
  cache.payload = payload;
  return payload;
}

export async function buildSignalPackage({
  packageId,
  targetAgent,
  opponentAgent,
  nRecent = 40,
}: {
  packageId: PackageId;
  targetAgent: string;
  opponentAgent?: string;
  nRecent?: number;
}) {
  const contractAddress = (process.env.CONTRACT_ADDRESS ?? "") as `0x${string}`;
  const rpcUrl = process.env.RPC_URL ?? process.env.BASE_RPC ?? "https://mainnet.base.org";
  if (!contractAddress) throw new Error("CONTRACT_ADDRESS not set");

  const statsPayload = await scanStats({ contractAddress, rpcUrl, maxRounds: 700 });
  const s = statsPayload.byAgent.get(norm(targetAgent)) || initStats(norm(targetAgent));

  const creatorSamples = s.creatorOddCount + s.creatorEvenCount;
  const creatorOddRate = ratio(s.creatorOddCount, creatorSamples);
  const creatorEvenRate = 1 - creatorOddRate;

  const recent = s.recentCreatorParity.slice(-Math.max(10, nRecent));
  const older = s.recentCreatorParity.slice(-Math.max(10, nRecent * 2), -Math.max(10, nRecent));
  const recentOdd = recent.filter((x: "ODD" | "EVEN") => x === "ODD").length;
  const olderOdd = older.filter((x: "ODD" | "EVEN") => x === "ODD").length;
  const recentOddRate = ratio(recentOdd, recent.length);
  const olderOddRate = ratio(olderOdd, older.length);
  const regimeDelta = Number((recentOddRate - olderOddRate).toFixed(3));

  const revealTotal = s.creatorRevealSuccess + s.creatorRevealTimeout;
  const revealReliability = ratio(s.creatorRevealSuccess, revealTotal);

  const oppStats = opponentAgent ? s.byOpponent[norm(opponentAgent)] : undefined;
  const matchupOddRate = oppStats
    ? ratio(oppStats.creatorOdd, oppStats.creatorOdd + oppStats.creatorEven)
    : null;
  const matchupShift = oppStats ? Number((matchupOddRate! - creatorOddRate).toFixed(3)) : null;

  const conf = confidence(creatorSamples, creatorOddRate);
  const recentStreak = getRecentStreak(s.recentCreatorParity, 5);
  // 2026-03-27: Lowered thresholds to reduce no_edge fallback rate
  // Previous: 0.52/0.48 bias, 0.08 regime delta → ~49 no_edge per 319 rounds (26%)
  // New: 0.505/0.495 bias, 0.04 regime delta → target ~10% no_edge
  const biasAction = actionFromOddRate(creatorOddRate, 0.505, 0.495);
  const regimeAction = actionFromDelta(regimeDelta, 0.04);
  const matchupAction =
    matchupOddRate === null ? "NO_EDGE" : actionFromOddRate(matchupOddRate, 0.505, 0.495);
  const action =
    majorityAction([biasAction, regimeAction, matchupAction, recentStreak.action]) !== "NO_EDGE"
      ? majorityAction([biasAction, regimeAction, matchupAction, recentStreak.action])
      : biasAction !== "NO_EDGE"
        ? biasAction
        : recentStreak.action !== "NO_EDGE"
          ? recentStreak.action
          : regimeAction !== "NO_EDGE"
            ? regimeAction
            : matchupAction;

  const packageSignal =
    packageId === "oe_bias_basic"
      ? biasAction
      : packageId === "oe_bias_delta"
        ? regimeAction !== "NO_EDGE"
          ? regimeAction
          : recentStreak.action
        : packageId === "oe_regime_watch"
          ? recentStreak.action !== "NO_EDGE"
            ? recentStreak.action
            : regimeAction
          : packageId === "oe_matchup_edge"
            ? matchupAction !== "NO_EDGE"
              ? matchupAction
              : biasAction
            : action;

  const base = {
    packageId,
    updatedAt: statsPayload.updatedAt,
    targetAgent: norm(targetAgent),
    sampleSize: creatorSamples,
    biasScore: {
      odd: Number(creatorOddRate.toFixed(3)),
      even: Number(creatorEvenRate.toFixed(3)),
      edge: Number(Math.abs(creatorOddRate - 0.5).toFixed(3)),
    },
  } as any;

  if (
    [
      "oe_bias_delta",
      "oe_regime_watch",
      "oe_signal_pro",
      "oe_action_reco",
      "oe_meta_adapt",
      "oe_risk_guard",
      "oe_full_dossier",
      "oe_alpha_feed_24h",
    ].includes(packageId)
  ) {
    base.regime = {
      recentWindow: recent.length,
      recentOddRate: Number(recentOddRate.toFixed(3)),
      priorOddRate: Number(olderOddRate.toFixed(3)),
      delta: regimeDelta,
      state: regimeDelta > 0.12 ? "SHIFT_TO_ODD" : regimeDelta < -0.12 ? "SHIFT_TO_EVEN" : "STABLE",
    };
    base.recentStreak = recentStreak;
  }

  if (
    [
      "oe_matchup_edge",
      "oe_signal_pro",
      "oe_action_reco",
      "oe_meta_adapt",
      "oe_risk_guard",
      "oe_full_dossier",
      "oe_alpha_feed_24h",
    ].includes(packageId)
  ) {
    base.matchup = {
      opponent: opponentAgent ? norm(opponentAgent) : null,
      shift: matchupShift,
      oddRateVsOpponent: matchupOddRate !== null ? Number(matchupOddRate!.toFixed(3)) : null,
      note: opponentAgent
        ? matchupShift === null
          ? "insufficient matchup sample"
          : "computed"
        : "opponent not provided",
    };
  }

  if (
    [
      "oe_reveal_reliability",
      "oe_signal_pro",
      "oe_action_reco",
      "oe_meta_adapt",
      "oe_risk_guard",
      "oe_full_dossier",
      "oe_alpha_feed_24h",
    ].includes(packageId)
  ) {
    base.revealReliability = {
      score: Number(revealReliability.toFixed(3)),
      success: s.creatorRevealSuccess,
      timeout: s.creatorRevealTimeout,
      risk: revealReliability < 0.65 ? "HIGH" : revealReliability < 0.82 ? "MEDIUM" : "LOW",
    };
  }

  base.signal = packageSignal;

  if (
    [
      "oe_matchup_edge",
      "oe_signal_pro",
      "oe_action_reco",
      "oe_meta_adapt",
      "oe_risk_guard",
      "oe_full_dossier",
      "oe_alpha_feed_24h",
    ].includes(packageId)
  ) {
    base.confidence = conf;
    base.recommendedAction = action;
    base.signalDrivers = {
      biasAction,
      regimeAction,
      matchupAction,
      streakAction: recentStreak.action,
    };
  }

  if (["oe_risk_guard", "oe_full_dossier", "oe_alpha_feed_24h"].includes(packageId)) {
    base.riskGuard = {
      overfitWarning: creatorSamples < 20,
      lowLiquidityWarning: creatorSamples < 12,
      noTradeZone: packageSignal === "NO_EDGE" || conf < 0.52,
    };
  }

  if (["oe_full_dossier", "oe_alpha_feed_24h"].includes(packageId)) {
    base.dossier = {
      roundsAsCreator: s.roundsAsCreator,
      roundsAsJoiner: s.roundsAsJoiner,
      joinGuessBias: {
        odd: Number(
          ratio(s.joinGuessOddCount, s.joinGuessOddCount + s.joinGuessEvenCount).toFixed(3)
        ),
        even: Number(
          (1 - ratio(s.joinGuessOddCount, s.joinGuessOddCount + s.joinGuessEvenCount)).toFixed(3)
        ),
      },
      scannedRounds: statsPayload.scannedRounds,
    };
  }

  if (packageId === "oe_alpha_feed_24h") {
    base.subscription = {
      windowHours: 24,
      mode: "snapshot",
      note: "MVP mode: returns latest computed snapshot. Stream mode can be added later.",
    };
  }

  return base;
}
