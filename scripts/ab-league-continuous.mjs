/**
 * ab-league-continuous.mjs
 * Continuous A/B league runner for Odds or Evens.
 *
 * Correct field names (from seller offering.json schemas):
 *   create_round: { number: integer, tier: "S"|"M"|"L" }
 *   join_round:   { roundId: string, guess: "ODD"|"EVEN" }
 *   reveal_round: { roundId: string }
 *   oe_action_reco: { targetAgent: string, opponentAgent: string }
 *
 * Group A (Baseline): random guess, no signal call.
 * Group B (Signal): calls oe_action_reco first, uses recommendedAction.
 *
 * Queue-based: 1 creator + 1 joiner per round. No deadlock.
 * Saves results to data/ab-league-results.json.
 * Runs forever until SIGTERM/SIGINT.
 */

import fs from "fs";
import { randomInt } from "crypto";
import { createWalletClient, createPublicClient, http, parseAbi, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import dotenv from "dotenv";
dotenv.config();

// Ensure /acp suffix is always present regardless of env var format
const _acp_raw = process.env.ACP_API_URL || "https://claw-api.virtuals.io";
const ACP_BASE = _acp_raw.endsWith("/acp") ? _acp_raw : `${_acp_raw}/acp`;
const PROVIDER = process.env.ACP_PROVIDER_WALLET || "0xB213021c4fDaaB4307ab4B9D3817868e60B27FD2";
const RESULTS_FILE = "./data/ab-league-results.json";

// Stake tier: XS = 0.01 USDC, S = 10 USDC, M = 50 USDC, L = 100 USDC
// Default to XS for low-cost V2C A/B execution.
const STAKE_TIER = process.env.STAKE_TIER || "XS";

// Account 3 buyer agents
const AGENTS = [
  { name: "MoltP20",    wallet: "0xCfa74dA852459A84772ce1c158388b610C81cA85", apiKey: "acp-f7ee6ceef6f6760090d7" },
  { name: "Nova Pulse", wallet: "0xD6000DE1215965e6B241Ca22159dD8b18142C7aa", apiKey: "acp-cede5f74539d84488fdf" },
  { name: "KaiBot",     wallet: "0x28578287cd74a1D5d7A64B4BbE20071Fd3bFC5a7", apiKey: "acp-5b9f640a33bf0703480b" },
];
// Zenith Loop: inject via env if available
if (process.env.ZENITH_API_KEY) {
  AGENTS.push({ name: "Zenith Loop", wallet: "0xfF031E145ce0DbaE9F0B58A28D7dBaF8aF504f86", apiKey: process.env.ZENITH_API_KEY });
  console.log("[league] Zenith Loop added with injected API key.");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── On-chain fund management ──────────────────────────────────────────────────
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TREASURY_ADDRESS = "0x39CE6c16C1Db05D904F504c7e7AeFD7eEC790F67";
const REFILL_THRESHOLD = parseUnits("0.1", 6);  // 0.1 USDC
const REFILL_AMOUNT    = parseUnits((process.env.REFILL_AMOUNT_USDC || "1"), 6);   // default 1 USDC per agent for XS league
const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)"
]);

// Lazy-init on-chain clients (require DEPLOYER_PRIVATE_KEY in env)
let _publicClient = null;
let _walletClient = null;

function getOnchainClients() {
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");
  if (!_publicClient) {
    // Use fallback RPCs to avoid rate limits on mainnet.base.org
    const fallbacks = (process.env.RPC_FALLBACKS || "").split(",").map(s => s.trim()).filter(Boolean);
    const rpcList = [process.env.BASE_RPC || "https://mainnet.base.org", ...fallbacks];
    // Pick a random one from the list to spread load
    const rpc = rpcList[Math.floor(Math.random() * rpcList.length)];
    console.log(`[funds] Using RPC: ${rpc}`);
    _publicClient = createPublicClient({ chain: base, transport: http(rpc) });
    const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
    _walletClient = createWalletClient({ account: deployer, chain: base, transport: http(rpc) });
    console.log(`[funds] On-chain clients ready. Deployer=${deployer.address}`);
  }
  return { publicClient: _publicClient, walletClient: _walletClient };
}

async function getUsdcBalance(publicClient, address) {
  return publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [address] });
}

/**
 * checkAndRefillFunds — called before each round.
 *
 * If ANY agent is below REFILL_THRESHOLD (0.1 USDC default):
 * 1. Each agent calls collect_to_treasury ACP job → USDC flows via ACP payment to treasury
 * 2. Treasury redistributes REFILL_AMOUNT (1 USDC default, env-overridable) equally to all agents
 *
 * Note: collect_to_treasury moves funds via ACP payment flow (AA wallet → contract → treasury).
 * The treasury→agent direction is done via direct on-chain transfer (deployer key).
 */
async function checkAndRefillFunds(agents) {
  let clients;
  try { clients = getOnchainClients(); } catch (e) {
    console.log(`[funds] Skipping fund check: ${e.message}`);
    return;
  }
  const { publicClient, walletClient } = clients;

  // Check all agent balances
  const balances = await Promise.all(agents.map(a => getUsdcBalance(publicClient, a.wallet)));
  const needsRefill = balances.some(b => b < REFILL_THRESHOLD);

  if (!needsRefill) {
    const summary = agents.map((a, i) => `${a.name}=${formatUnits(balances[i], 6)}`).join(", ");
    console.log(`[funds] Balances OK: ${summary}`);
    return;
  }

  console.log(`[funds] ⚠️  Low balance detected — initiating collect-then-redistribute`);
  console.log(`[funds] Step 1: Collect all agent funds to treasury via collect_to_treasury ACP job`);

  // Step 1: Each agent with meaningful balance calls collect_to_treasury job
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const bal = balances[i];
    const balUsdc = Number(formatUnits(bal, 6));
    if (balUsdc < 1) {
      console.log(`[funds] ${agent.name} balance too low to collect (${balUsdc} USDC), skipping`);
      continue;
    }
    // Collect all but 0.5 USDC (leave for gas/fee buffer)
    const collectAmount = Math.max(0, balUsdc - 0.5).toFixed(2);
    if (Number(collectAmount) < 0.5) {
      console.log(`[funds] ${agent.name} nothing significant to collect`);
      continue;
    }
    console.log(`[funds] ${agent.name} collecting ${collectAmount} USDC to treasury via ACP job...`);
    try {
      await callJob(agent.apiKey, "collect_to_treasury", { amount_usdc: Number(collectAmount) }, 180000);
      const newBal = await getUsdcBalance(publicClient, agent.wallet);
      console.log(`[funds] ✅ ${agent.name} collected → balance now ${formatUnits(newBal, 6)} USDC`);
    } catch (e) {
      console.error(`[funds] ❌ collect_to_treasury failed for ${agent.name}: ${e.message}. Skipping.`);
    }
  }

  console.log(`[funds] Step 2: Redistributing ${formatUnits(REFILL_AMOUNT, 6)} USDC to each agent from treasury`);

  // Step 2: Treasury distributes equally to all agents
  const treasuryBalance = await getUsdcBalance(publicClient, TREASURY_ADDRESS);
  const totalNeeded = REFILL_AMOUNT * BigInt(agents.length);
  console.log(`[funds] Treasury: ${formatUnits(treasuryBalance, 6)} USDC, need: ${formatUnits(totalNeeded, 6)} USDC for ${agents.length} agents`);

  if (treasuryBalance < totalNeeded) {
    console.log(`[funds] ❌ Treasury insufficient for full redistribution. Distributing proportionally.`);
    // Distribute what we can equally
    const perAgent = treasuryBalance / BigInt(agents.length);
    if (perAgent < parseUnits("1", 6)) {
      console.log(`[funds] ❌ Treasury too low even for proportional distribution. Aborting.`);
      return;
    }
    for (const agent of agents) {
      try {
        const hash = await walletClient.writeContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "transfer", args: [agent.wallet, perAgent] });
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`[funds] ✅ ${agent.name} received ${formatUnits(perAgent, 6)} USDC (tx=${hash})`);
      } catch (e) {
        console.error(`[funds] ❌ Transfer failed for ${agent.name}: ${e.message}`);
      }
    }
    return;
  }

  for (const agent of agents) {
    try {
      const hash = await walletClient.writeContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "transfer", args: [agent.wallet, REFILL_AMOUNT] });
      await publicClient.waitForTransactionReceipt({ hash });
      const newBal = await getUsdcBalance(publicClient, agent.wallet);
      console.log(`[funds] ✅ ${agent.name} redistributed → ${formatUnits(newBal, 6)} USDC (tx=${hash})`);
    } catch (e) {
      console.error(`[funds] ❌ Redistribution failed for ${agent.name}: ${e.message}`);
    }
  }
}

function normalizeResults(raw = {}) {
  const rounds = Array.isArray(raw.rounds) ? raw.rounds : [];
  const baseStats = raw.stats || raw.summary || {};
  return {
    ...raw,
    rounds,
    stats: {
      A: { wins: Number(baseStats?.A?.wins || 0), losses: Number(baseStats?.A?.losses || 0) },
      B: { wins: Number(baseStats?.B?.wins || 0), losses: Number(baseStats?.B?.losses || 0) },
    },
    startedAt: raw.startedAt || new Date().toISOString(),
  };
}

function loadResults() {
  try { return normalizeResults(JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"))); }
  catch {
    return normalizeResults({});
  }
}

function saveResults(data) {
  fs.mkdirSync("./data", { recursive: true });
  const normalized = normalizeResults(data);
  normalized.summary = normalized.stats; // keep KPI readers that still expect summary working
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(normalized, null, 2));
}

async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = { raw: txt }; }
  return { ok: r.ok, status: r.status, body };
}

async function callJob(apiKey, offering, requirements, timeoutMs = 180000) {
  const created = await jfetch(`${ACP_BASE}/jobs`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      providerWalletAddress: PROVIDER,
      jobOfferingName: offering,
      serviceRequirements: requirements
    })
  });
  if (!created.ok) throw new Error(`create_job[${offering}] failed (${created.status}): ${JSON.stringify(created.body).slice(0,300)}`);
  // API may return data.id or data.jobId
  const jobId = created.body?.data?.id ?? created.body?.data?.jobId;
  if (!jobId) throw new Error(`no jobId from ${offering}: ${JSON.stringify(created.body).slice(0,300)}`);

  console.log(`[job] ${offering} → jobId=${jobId}`);

  // Poll for completion
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    const s = await jfetch(`${ACP_BASE}/jobs/${jobId}`, { headers: { "x-api-key": apiKey } });
    const phase = String(s.body?.data?.phase ?? "");
    const errors = Array.isArray(s.body?.errors) ? s.body.errors : [];
    if (errors.length > 0) {
      const errText = errors.join(" | ");
      if (/insufficient balance/i.test(errText)) {
        throw new Error(`job ${jobId} payment blocker: ${errText}`);
      }
      console.log(`[job] ${offering}/${jobId} api-errors=${errText}`);
    }
    // Phase: REQUEST, NEGOTIATION, TRANSACTION, EVALUATION, COMPLETED, REJECTED, EXPIRED
    const phaseLower = phase.toLowerCase();
    if (["completed","delivered","evaluation","4"].some(p => phaseLower.includes(p))) {
      return { jobId, result: s.body?.data };
    }
    if (["failed","rejected","cancelled","expired","5","6","7","8","9"].some(p => phaseLower.includes(p))) {
      throw new Error(`job ${jobId} terminal state: phase=${phase}`);
    }
    console.log(`[job] ${offering}/${jobId} phase=${phase} (${Math.round((Date.now()-start)/1000)}s elapsed)`);
  }
  throw new Error(`job ${offering}/${jobId} timeout after ${timeoutMs}ms`);
}

function parseDeliverable(result) {
  // deliverable may be string JSON or object
  const raw = result?.deliverable ?? result?.data?.deliverable ?? result?.serviceRequirements ?? "";
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return { raw }; }
}

/**
 * Group B — Role-aware ranked signal chain.
 *
 * We previously rotated a single package globally. That kept queue load low,
 * but it also mixed weak packages into both roles and dropped straight to
 * random on the first NO_EDGE/error. The current strategy keeps the runner
 * sequential while retrying through a short ranked chain before fallback.
 */

function extractAction(d) {
  const v = d?.value ?? d;
  const raw = v?.recommendedAction || v?.action || v?.recommendation || v?.signal || v?.direction || "";
  const s = String(raw).toUpperCase();
  if (s.includes("ODD"))  return "ODD";
  if (s.includes("EVEN")) return "EVEN";
  return null;
}

function extractSignalMeta(d) {
  const v = d?.value ?? d ?? {};
  const confidence = Number(
    v?.confidence ?? v?.score ?? v?.strength ?? v?.meta?.confidence ?? NaN
  );
  // 2026-03-28 fix: prefer matchup.shift for oe_matchup_edge (was using global biasScore.edge)
  const matchupShift = Number(v?.matchup?.shift ?? NaN);
  const edge = Number(
    Number.isFinite(matchupShift) ? Math.abs(matchupShift)
    : (v?.edge ?? v?.biasScore?.edge ?? v?.meta?.edge ?? NaN)
  );
  return {
    confidence: Number.isFinite(confidence) ? confidence : null,
    edge: Number.isFinite(edge) ? edge : null,
  };
}

async function fetchSignal(callerApiKey, offering, params, timeout = 180000) {
  try {
    const { result } = await callJob(callerApiKey, offering, params, timeout);
    const deliverable = parseDeliverable(result);
    // unwrap { type, value } envelope used by signal offerings
    const _v = deliverable?.value ?? deliverable;
    const rawAction = _v?.recommendedAction || _v?.action || _v?.recommendation || _v?.signal || _v?.direction || null;
    const meta = extractSignalMeta(deliverable);
    return {
      action: extractAction(deliverable),
      rawAction: rawAction ? String(rawAction).toUpperCase() : null,
      deliverable,
      confidence: meta.confidence,
      edge: meta.edge,
      error: null,
    };
  } catch (e) {
    return {
      action: null,
      rawAction: null,
      deliverable: null,
      confidence: null,
      edge: null,
      error: String(e?.message || e),
    };
  }
}

const CREATOR_SIGNAL_CHAIN = [
  { name: "oe_matchup_edge", needsOpponent: true },
  { name: "oe_action_reco", needsOpponent: true },
  { name: "oe_bias_delta", needsOpponent: false }, // 3rd tier: allowed only if confidence >= 0.6
];

// 2026-03-28 러시안블루 분석:
// oe_matchup_edge counter 56.0% (n=134) → 유일하게 유의미한 신호
// oe_action_reco counter 52.6% (n=57) → 동전 던지기 수준, confidence 항상 >0.7로 gate 무효
// oe_action_reco를 chain에서 제거하면 fallback으로 빠지는데,
// fallback-random(47.2%)보다 oe_action_reco(52.6%)가 아직 약간 나으므로
// 2nd tier로 유지하되, 향후 추가 데이터로 재평가
const JOINER_SIGNAL_CHAIN = [
  { name: "oe_matchup_edge", needsOpponent: true },
  { name: "oe_action_reco", needsOpponent: true },  // marginal: 52.6% counter, 55.6% actual B-win
];

async function getRankedSignal(callerApiKey, callerName, targetWallet, opponentWallet, chain, acceptSignal = null) {
  const t = targetWallet.slice(0, 10);
  let last = null;

  for (const sig of chain) {
    console.log(`[signal] ${callerName} → ${sig.name} (target=${t}...)`);
    const params = sig.needsOpponent
      ? { targetAgent: targetWallet, opponentAgent: opponentWallet }
      : { targetAgent: targetWallet };

    const result = await fetchSignal(callerApiKey, sig.name, params);
    console.log(`[signal] ${callerName} ${sig.name} → ${result.action || "NULL"}`);
    last = {
      offering: sig.name,
      action: result.action,
      rawAction: result.rawAction,
      deliverable: result.deliverable,
      confidence: result.confidence,
      edge: result.edge,
      error: result.error || null,
    };

    if (!result.action) continue;
    if (typeof acceptSignal === 'function' && !acceptSignal(last)) {
      console.log(`[signal] ${callerName} ${sig.name} rejected by quality gate (confidence=${last.confidence}, edge=${last.edge})`);
      continue;
    }
    return last;
  }

  return last || {
    offering: null,
    action: null,
    rawAction: null,
    deliverable: null,
    confidence: null,
    edge: null,
    error: null,
  };
}

function joinerSignalAllowed(signal) {
  if (!signal?.action || !signal?.offering) return false;
  if (signal.offering === 'oe_matchup_edge') {
    // 2026-03-28 러시안블루 분석: threshold 0.04→0.02 완화
    // tiny shift(<0.03) counter 59.6%, small(0.03-0.06) 56.0%
    // medium(0.06-0.1)은 오히려 50/50 → 높은 threshold가 나쁜 시그널만 남김
    // 거의 모든 matchup_edge 신호를 수용하되 action이 있으면 됨
    const edgeOk = signal.edge != null ? Math.abs(signal.edge) >= 0.02 : false;
    const confidenceOk = signal.confidence != null ? signal.confidence >= 0.55 : false;
    return edgeOk || confidenceOk;
  }
  if (signal.offering === 'oe_action_reco') {
    // confidence가 항상 >0.7이라 gate 무의미. 그냥 action 있으면 수용.
    return true;
  }
  return false;
}

// 2026-03-28 v11: Adaptive direction based on recent signal accuracy.
// CRITICAL FIX: counter was locked while signal accuracy rose to 75% in recent 20R,
// meaning B was betting AGAINST a correct signal → 20.8% WR structural collapse.
// Now: measure recent signal accuracy and follow/counter accordingly.
let _cachedJoinerMode = null;
let _joinerModeRoundIdx = -1;

function getJoinerMode(results) {
  // Cache per round to avoid recomputing within the same round
  const currentRound = (results?.rounds || []).length;
  if (_joinerModeRoundIdx === currentRound && _cachedJoinerMode) return _cachedJoinerMode;

  const recent = (results?.rounds || [])
    .filter(r => r?.joiner?.strategy === 'B')
    .filter(r => r?.joiner?.decisionSource === 'signal-counter' || r?.joiner?.decisionSource === 'signal-align')
    .filter(r => r?.joiner?.signalAction && r?.revealedResult)
    .slice(-20);

  let mode;
  // v15: only count rounds where signal was actually used (rawAction non-null)
  // This excludes the pre-fix era where recommendedAction was always null
  const recentWithSignal = recent.filter(r => r?.joiner?.signalRecommendedActionRaw);
  if (recentWithSignal.length < 12) {
    // Not enough post-fix signal data — force align to bootstrap accuracy tracking
    mode = 'align';
    console.log(`[adaptive-joiner] bootstrap: only ${recentWithSignal.length} rounds with real signal → force align`);
  } else {
    const correct = recent.filter(r => r.joiner.signalAction === r.revealedResult).length;
    const accuracy = correct / recent.length;
    // v14: tightened thresholds — weak edge is still exploitable in i.i.d. games
    if (accuracy >= 0.53) mode = 'align';
    else if (accuracy <= 0.47) mode = 'counter';
    else mode = 'random';
    console.log(`[adaptive-joiner] recent ${recent.length}R signal accuracy=${(accuracy*100).toFixed(1)}% → mode=${mode}`);
  }

  _cachedJoinerMode = mode;
  _joinerModeRoundIdx = currentRound;
  return mode;
}

async function getSignalForJoiner(joinerAgent, creatorWallet, results) {
  const signal = await getRankedSignal(
    joinerAgent.apiKey,
    joinerAgent.name,
    creatorWallet,
    joinerAgent.wallet,
    JOINER_SIGNAL_CHAIN,
    joinerSignalAllowed,
  );

  if (signal.action) {
    const mode = getJoinerMode(results);
    let guess, label;
    if (mode === 'align') {
      guess = signal.action;
      label = 'align';
    } else if (mode === 'counter') {
      guess = signal.action === "ODD" ? "EVEN" : "ODD";
      label = 'counter';
    } else {
      // random mode: ignore signal, pure random
      guess = randomInt(0, 2) === 0 ? "ODD" : "EVEN";
      label = 'random-neutral';
    }
    console.log(`[signal] ${joinerAgent.name} creator biased ${signal.action} → joiner picks ${guess} (${label})`);
    return {
      guess,
      decisionSource: `signal-${label}`,
      signalPackage: signal.offering,
      signalAction: signal.action,
      signalRecommendedActionRaw: signal.rawAction,
      fallbackReason: null,
      signalDeliverable: signal.deliverable,
      signalError: signal.error,
    };
  }

  // 2026-03-28: anti-bias fallback had 40.7% WR (worse than random 50%).
  // Mean-reversion assumption doesn't hold in i.i.d. game. Pure random is safer.
  const rand = randomInt(0, 2) === 0 ? "ODD" : "EVEN";
  console.log(`[signal] ${joinerAgent.name} chain exhausted → random fallback=${rand}`);
  return {
    guess: rand,
    decisionSource: 'fallback-random',
    signalPackage: signal.offering,
    signalAction: signal.action,
    signalRecommendedActionRaw: signal.rawAction,
    fallbackReason: signal.error ? 'error' : 'no_edge',
    signalDeliverable: signal.deliverable,
    signalError: signal.error,
  };
}

function creatorSignalAllowed(signal) {
  if (!signal?.action || !signal?.offering) return false;
  if (signal.offering === 'oe_matchup_edge' || signal.offering === 'oe_action_reco') return true;
  // oe_bias_delta allowed as 3rd-tier if confidence >= 0.6 (strict gate to filter weak signals)
  if (signal.offering === 'oe_bias_delta') {
    return signal.confidence != null && signal.confidence >= 0.6;
  }
  return false;
}

/**
 * Group B — Creator strategy (2026-03-28 v5: per-agent anti-bias).
 * Tracks each A-joiner's ODD/EVEN guess history and picks the opposite.
 * A-joiner agents show persistent ODD bias (~55%), exploiting that
 * should lift B-Creator from ~48% toward ~54%.
 * Falls back to random if insufficient history (<5 rounds vs that joiner).
 */
const _opponentGuessHistory = {}; // { agentName: { ODD: number, EVEN: number } }
let _historyBootstrapped = false;

function _bootstrapOpponentHistory(results) {
  if (_historyBootstrapped) return;
  for (const r of (results.rounds || [])) {
    if (r.creator?.strategy === "B" && r.joiner?.name && r.joiner?.guess) {
      if (!_opponentGuessHistory[r.joiner.name]) _opponentGuessHistory[r.joiner.name] = { ODD: 0, EVEN: 0 };
      _opponentGuessHistory[r.joiner.name][r.joiner.guess]++;
    }
    if (r.joiner?.strategy === "B" && r.creator?.name && r.creator?.impliedGuess) {
      if (!_opponentGuessHistory[r.creator.name]) _opponentGuessHistory[r.creator.name] = { ODD: 0, EVEN: 0 };
      _opponentGuessHistory[r.creator.name][r.creator.impliedGuess]++;
    }
  }
  _historyBootstrapped = true;
  console.log(`[league] Opponent history bootstrapped:`, JSON.stringify(_opponentGuessHistory));
}

// 2026-03-28 v12: Creator adaptive direction.
// Creator signal predicts joiner's tendency. Direction (counter vs follow) is now adaptive
// based on recent accuracy of creator signal vs actual joiner guesses.
let _cachedCreatorMode = null;
let _creatorModeRoundIdx = -1;

function getCreatorMode(results) {
  const currentRound = (results?.rounds || []).length;
  if (_creatorModeRoundIdx === currentRound && _cachedCreatorMode) return _cachedCreatorMode;

  const recent = (results?.rounds || [])
    .filter(r => r?.creator?.strategy === 'B')
    .filter(r => r?.creator?.decisionSource === 'signal-counter-creator' || r?.creator?.decisionSource === 'signal-follow-creator')
    .filter(r => r?.creator?.signalAction && r?.joiner?.guess)
    .slice(-20);

  let mode;
  // v15: only count rounds where signal was actually used (rawAction non-null)
  const recentWithSignal = recent.filter(r => r?.creator?.signalRecommendedActionRaw);
  if (recentWithSignal.length < 12) {
    // Not enough post-fix signal data — force follow to bootstrap
    mode = 'follow';
    console.log(`[adaptive-creator] bootstrap: only ${recentWithSignal.length} rounds with real signal → force follow`);
  } else {
    // Signal accuracy = how often signal predicted joiner's actual guess correctly
    const correct = recent.filter(r => r.creator.signalAction === r.joiner.guess).length;
    const accuracy = correct / recent.length;
    // v14: tightened thresholds — weak edge is still exploitable in i.i.d. games
    if (accuracy >= 0.53) mode = 'counter';    // signal matches joiner guess → counter it
    else if (accuracy <= 0.47) mode = 'follow'; // signal is inverse → follow means opposite of joiner
    else mode = 'random';
    console.log(`[adaptive-creator] recent ${recent.length}R signal accuracy=${(accuracy*100).toFixed(1)}% → mode=${mode}`);
  }

  _cachedCreatorMode = mode;
  _creatorModeRoundIdx = currentRound;
  return mode;
}

async function getSignalForCreator(creatorAgent, joinerWallet, joinerName, results) {
  const signal = await getRankedSignal(
    creatorAgent.apiKey,
    creatorAgent.name,
    joinerWallet,         // target = joiner (opponent)
    creatorAgent.wallet,  // self
    CREATOR_SIGNAL_CHAIN,
    creatorSignalAllowed,
  );

  if (signal.action) {
    const mode = getCreatorMode(results);
    let guess, label;
    if (mode === 'counter') {
      // Signal predicts joiner's tendency → pick opposite so joiner guesses wrong
      guess = signal.action === "ODD" ? "EVEN" : "ODD";
      label = 'counter';
    } else if (mode === 'follow') {
      // Signal is inverse-correlated with joiner → follow = same as signal
      guess = signal.action;
      label = 'follow';
    } else {
      // Random: ignore signal
      guess = randomInt(0, 2) === 0 ? "ODD" : "EVEN";
      label = 'random-neutral';
    }
    console.log(`[signal] ${creatorAgent.name} creator-signal ${signal.offering} → ${signal.action} => ${label} ${guess}`);
    return {
      guess,
      decisionSource: `signal-${label}-creator`,
      signalPackage: signal.offering,
      signalAction: signal.action,
      signalRecommendedActionRaw: signal.rawAction,
      fallbackReason: null,
      signalDeliverable: signal.deliverable,
      signalError: signal.error,
    };
  }

  // Fallback: pure random
  const rand = randomInt(0, 2) === 0 ? "ODD" : "EVEN";
  console.log(`[signal] ${creatorAgent.name} creator chain exhausted → random fallback=${rand}`);
  return {
    guess: rand,
    decisionSource: 'fallback-random-creator',
    signalPackage: signal.offering,
    signalAction: signal.action,
    signalRecommendedActionRaw: signal.rawAction,
    fallbackReason: signal.error ? 'error' : 'no_edge',
    signalDeliverable: signal.deliverable,
    signalError: signal.error,
  };
}

// Pair rotation: covers all unique pairs
function pickMatch(agents, roundIdx) {
  const n = agents.length;
  // Build all unique pairs
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  const [ci, ji] = pairs[roundIdx % pairs.length];
  return { creator: agents[ci], joiner: agents[ji] };
}

// Pick two disjoint matches per slot with explicit direction rotation.
// For 4 agents, a full 6-slot / 12-round cycle makes every agent appear
// exactly 3x as creator and 3x as joiner.
function pickParallelMatches(agents, slotIdx) {
  if (agents.length !== 4) {
    const first = pickMatch(agents, slotIdx * 2);
    const second = pickMatch(agents, slotIdx * 2 + 1);
    return [first, second];
  }

  const slots = [
    [[0, 1], [2, 3]],
    [[0, 2], [1, 3]],
    [[0, 3], [1, 2]],
    [[1, 0], [3, 2]],
    [[2, 0], [3, 1]],
    [[3, 0], [2, 1]],
  ];

  const slot = slots[slotIdx % slots.length];
  return slot.map(([creatorIdx, joinerIdx]) => ({
    creator: agents[creatorIdx],
    joiner: agents[joinerIdx],
  }));
}

function pickStrategies(roundIdx) {
  // Alternate each round: A/B swap
  if (roundIdx % 2 === 0) return { creatorStrategy: "A", joinerStrategy: "B" };
  return { creatorStrategy: "B", joinerStrategy: "A" };
}

async function runRound(roundIdx, results, matchOverride, strategyOverride) {
  const { creator, joiner } = matchOverride || pickMatch(AGENTS, roundIdx);
  const { creatorStrategy, joinerStrategy } = strategyOverride || pickStrategies(roundIdx);

  console.log(`\n[league] ===== Round ${roundIdx + 1} =====`);
  console.log(`[league] ${creator.name}(${creatorStrategy}) vs ${joiner.name}(${joinerStrategy})`);

  // B strategy: get signal first
  let creatorGuess = randomInt(0, 2) === 0 ? "ODD" : "EVEN";
  let joinerGuess  = randomInt(0, 2) === 0 ? "ODD" : "EVEN";
  let creatorDecisionMeta = { decisionSource: 'random-baseline', signalPackage: null, signalAction: null, signalRecommendedActionRaw: null, fallbackReason: null, signalDeliverable: null, signalError: null };
  let joinerDecisionMeta  = { decisionSource: 'random-baseline', signalPackage: null, signalAction: null, signalRecommendedActionRaw: null, fallbackReason: null, signalDeliverable: null, signalError: null };

  // 2026-03-28 v14: Re-enable signal calls for B strategy.
  // v13 disabled signals based on pre-adaptive (v11/v12) data.
  // Adaptive system (getJoinerMode/getCreatorMode) was never tested in production.
  // Re-activating for 200-round experiment to measure adaptive performance.
  // Thresholds tightened: align >= 0.53, counter <= 0.47 (was 0.58/0.42).
  if (creatorStrategy === "B") {
    _bootstrapOpponentHistory(results);
    const creatorSignal = await getSignalForCreator(creator, joiner.wallet, joiner.name, results);
    creatorGuess = creatorSignal.guess;
    creatorDecisionMeta = creatorSignal;
    console.log(`[league] ${creator.name} B-creator → ${creatorSignal.decisionSource} → ${creatorGuess}`);
  }
  if (joinerStrategy === "B") {
    const joinerSignal = await getSignalForJoiner(joiner, creator.wallet, results);
    joinerGuess = joinerSignal.guess;
    joinerDecisionMeta = joinerSignal;
    console.log(`[league] ${joiner.name} B-joiner → ${joinerSignal.decisionSource} → ${joinerGuess}`);
  }

  // Step 1: Creator creates round
  // create_round needs: { number: integer, tier: "S"|"M"|"L" }
  // number is the creator's secret; guess is derived from it (odd number = ODD)
  const secretNumber = creatorGuess === "ODD"
    ? 2 * randomInt(1, 50) - 1   // odd: 1,3,5,...99
    : 2 * randomInt(1, 50);      // even: 2,4,6,...100

  console.log(`[league] ${creator.name} creating round (number=${secretNumber}, tier=${STAKE_TIER}, impliedGuess=${creatorGuess})...`);
  let createResult;
  try {
    createResult = await callJob(creator.apiKey, "create_round", {
      number: secretNumber,
      tier: STAKE_TIER
    });
  } catch (e) {
    console.error(`[league] create_round failed: ${e.message}`);
    return null;
  }

  // Extract roundId from deliverable
  const createDel = parseDeliverable(createResult.result);
  const roundId = createDel?.roundId || createDel?.round_id || createDel?.id;
  if (!roundId) {
    console.error(`[league] no roundId from create_round: ${JSON.stringify(createDel).slice(0,300)}`);
    return null;
  }
  console.log(`[league] Round created: roundId=${roundId}`);

  // Step 2: Joiner joins
  // join_round needs: { roundId: string, guess: "ODD"|"EVEN" }
  console.log(`[league] ${joiner.name} joining round ${roundId} (guess=${joinerGuess})...`);
  try {
    await callJob(joiner.apiKey, "join_round", {
      roundId: roundId.toString(),
      guess: joinerGuess
    });
  } catch (e) {
    console.error(`[league] join_round failed: ${e.message}`);
    return null;
  }

  // Step 3: Creator reveals
  // reveal_round needs: { roundId: string }
  console.log(`[league] ${creator.name} revealing round ${roundId}...`);
  let revealResult;
  try {
    revealResult = await callJob(creator.apiKey, "reveal_round", {
      roundId: roundId.toString()
    });
  } catch (e) {
    console.error(`[league] reveal_round failed: ${e.message}`);
    return null;
  }

  // Parse result: revealRound returns { roundId, revealedNumber, result: "ODD"|"EVEN", txHash, message }
  // Winner determination: creator chose secretNumber (ODD/EVEN),
  //   if joiner guessed same as result → joiner wins; else creator wins.
  const revealDel = parseDeliverable(revealResult.result);
  const revealedResult = revealDel?.result; // "ODD" or "EVEN"
  console.log(`[league] Revealed: result=${revealedResult}, creator implied ${creatorGuess}, joiner guessed ${joinerGuess}`);

  let creatorWon = false;
  let joinerWon = false;
  if (revealedResult) {
    // Joiner wins if their guess matches the revealed result
    joinerWon = joinerGuess === revealedResult;
    creatorWon = !joinerWon;
  }

  const roundRecord = {
    roundIdx: roundIdx + 1,
    roundId,
    creator: {
      name: creator.name,
      wallet: creator.wallet,
      strategy: creatorStrategy,
      secretNumber,
      impliedGuess: creatorGuess,
      won: creatorWon,
      decisionSource: creatorDecisionMeta.decisionSource,
      signalPackage: creatorDecisionMeta.signalPackage,
      signalAction: creatorDecisionMeta.signalAction,
      signalRecommendedActionRaw: creatorDecisionMeta.signalRecommendedActionRaw,
      fallbackReason: creatorDecisionMeta.fallbackReason,
      signalDeliverable: creatorDecisionMeta.signalDeliverable,
      signalError: creatorDecisionMeta.signalError,
    },
    joiner:  {
      name: joiner.name,
      wallet: joiner.wallet,
      strategy: joinerStrategy,
      guess: joinerGuess,
      won: joinerWon,
      decisionSource: joinerDecisionMeta.decisionSource,
      signalPackage: joinerDecisionMeta.signalPackage,
      signalAction: joinerDecisionMeta.signalAction,
      signalRecommendedActionRaw: joinerDecisionMeta.signalRecommendedActionRaw,
      fallbackReason: joinerDecisionMeta.fallbackReason,
      signalDeliverable: joinerDecisionMeta.signalDeliverable,
      signalError: joinerDecisionMeta.signalError,
    },
    revealedResult,
    winner: creatorWon ? creator.name : joinerWon ? joiner.name : "unknown",
    timestamp: new Date().toISOString()
  };

  // Update stats
  if (creatorWon) { results.stats[creatorStrategy].wins++; results.stats[joinerStrategy].losses++; }
  else if (joinerWon) { results.stats[joinerStrategy].wins++; results.stats[creatorStrategy].losses++; }

  results.rounds.push(roundRecord);

  // Track opponent guess history for anti-bias strategy
  if (creatorStrategy === "B" && joinerGuess) {
    if (!_opponentGuessHistory[joiner.name]) _opponentGuessHistory[joiner.name] = { ODD: 0, EVEN: 0 };
    _opponentGuessHistory[joiner.name][joinerGuess]++;
  }
  if (joinerStrategy === "B" && creatorGuess) {
    if (!_opponentGuessHistory[creator.name]) _opponentGuessHistory[creator.name] = { ODD: 0, EVEN: 0 };
    _opponentGuessHistory[creator.name][creatorGuess]++;
  }

  saveResults(results);

  console.log(`[league] ✓ Round ${roundIdx+1} done: winner=${roundRecord.winner}`);
  console.log(`[league] Stats | A: ${results.stats.A.wins}W/${results.stats.A.losses}L | B: ${results.stats.B.wins}W/${results.stats.B.losses}L`);
  return roundRecord;
}

async function main() {
  console.log(`[league] A/B League starting with ${AGENTS.length} agents (stake tier=${STAKE_TIER})`);
  console.log(`[league] Agents: ${AGENTS.map(a => a.name).join(", ")}`);
  console.log("[league] Press Ctrl+C or send SIGTERM to stop.\n");

  const results = loadResults();
  _bootstrapOpponentHistory(results);
  let roundIdx = results.rounds.length;
  if (roundIdx > 0) console.log(`[league] Resuming from round ${roundIdx + 1} (${results.rounds.length} prior rounds loaded)`);

  process.on("SIGTERM", () => {
    console.log("[league] SIGTERM received. Saving and exiting.");
    saveResults(results);
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log("[league] SIGINT received. Saving and exiting.");
    saveResults(results);
    process.exit(0);
  });

  let slotIdx = Math.floor(roundIdx / 2); // each slot runs 2 rounds

  while (true) {
    try {
      await checkAndRefillFunds(AGENTS);

      if (AGENTS.length >= 4) {
        // Run 2 disjoint matches sequentially, with creator/joiner direction balanced across a 12-round cycle
        const matches = pickParallelMatches(AGENTS, slotIdx);
        const strategies = [pickStrategies(roundIdx), pickStrategies(roundIdx + 1)];

        console.log(`\n[league] ===== Slot ${slotIdx + 1} (Rounds ${roundIdx + 1} & ${roundIdx + 2}) — SEQUENTIAL =====`);
        console.log(`[league] Round 1: ${matches[0].creator.name}(${strategies[0].creatorStrategy}) vs ${matches[0].joiner.name}(${strategies[0].joinerStrategy})`);
        console.log(`[league] Round 2: ${matches[1].creator.name}(${strategies[1].creatorStrategy}) vs ${matches[1].joiner.name}(${strategies[1].joinerStrategy})`);

        const r1 = await runRound(roundIdx,     results, matches[0], strategies[0]).catch(e => { console.error(`[league] Round 1 error: ${e.message}`); return null; });
        const r2 = await runRound(roundIdx + 1, results, matches[1], strategies[1]).catch(e => { console.error(`[league] Round 2 error: ${e.message}`); return null; });

        roundIdx += 2;
        slotIdx++;
      } else {
        // Fallback: sequential for < 4 agents
        await runRound(roundIdx, results);
        roundIdx++;
      }

      await sleep(1000);
    } catch (e) {
      const msg = String(e?.message || e);
      console.error(`[league] Unhandled error near round ${roundIdx + 1}: ${msg}`);
      const backoffMs = /insufficient balance|payment blocker/i.test(msg) ? 300000 : 5000;
      console.log(`[league] Backing off for ${Math.round(backoffMs / 1000)}s before retry...`);
      await sleep(backoffMs);
    }
  }
}

main().catch(console.error);
