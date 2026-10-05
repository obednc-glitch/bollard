import fs from "node:fs";
import express from "express";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, parseUnits, formatUnits, pad, encodeFunctionData, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { Implementation, toMetaMaskSmartAccount, createDelegation, createExecution, ExecutionMode } from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import * as B from "./bollard-core.mjs";

// ---- config: env vars on Render, keys.json locally ----
const k = fs.existsSync("keys.json") ? JSON.parse(fs.readFileSync("keys.json", "utf8")) : {};
const owner = privateKeyToAccount(process.env.OWNER_KEY || k.owner);
const agent = privateKeyToAccount(process.env.AGENT_KEY || k.agent);
const vendors = {
  "DataFeed Co": process.env.VENDOR_A || privateKeyToAccount(k.vendor).address,
  "ShadyAPI": process.env.VENDOR_B || privateKeyToAccount(k.vendor2).address,
};
const ADMIN = process.env.ADMIN_TOKEN;
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3"; // Circle USDC on Monad testnet (6 decimals)
const ERC20 = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];
if (!ADMIN) console.warn("ADMIN_TOKEN not set: admin actions are disabled");

const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const mk = (account) => createWalletClient({ account, chain: monadTestnet, transport: http() });
const ownerW = mk(owner), agentW = mk(agent);
const treasury = await toMetaMaskSmartAccount({
  client: pub, implementation: Implementation.Hybrid,
  deployParams: [owner.address, [], [], []], deploySalt: "0x", signer: { account: owner },
});
const DM = treasury.environment.DelegationManager;

// ---- state (file-backed; resets if the host disk is wiped) ----
const FILE = "state.json";
let S = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { policy: null, meta: null, log: [] };
const save = () => fs.writeFileSync(FILE, JSON.stringify(S));
S.users = S.users || {};
const salt = () => numberToHex(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
const now = () => Math.floor(Date.now() / 1000);

async function makePolicy(cap, ttlMin, asset = "MON") {
  const usdc = asset === "USDC";
  const expires = now() + ttlMin * 60;
  const d = createDelegation({
    to: agent.address, from: treasury.address, environment: treasury.environment,
    scope: usdc
      ? { type: "erc20TransferAmount", tokenAddress: USDC, maxAmount: parseUnits(cap, 6) }
      : { type: "nativeTokenTransferAmount", maxAmount: parseEther(cap) },
    caveats: [
      // USDC: the call target is the token, so pin the recipient inside the transfer calldata instead
      usdc ? { type: "allowedCalldata", startIndex: 4, value: pad(vendors["DataFeed Co"], { size: 32 }) }
           : { type: "allowedTargets", targets: [vendors["DataFeed Co"]] },
      { type: "timestamp", afterThreshold: now() - 300, beforeThreshold: expires },
    ],
    salt: salt(),
  });
  S.policy = { ...d, signature: await treasury.signDelegation({ delegation: d }) };
  S.meta = { cap, expires, revoked: false, asset };
  save();
}

function why(reason) {
  if (!reason) return "Rejected by policy";
  if (/allowance-exceeded/i.test(reason)) return "Would exceed the total budget";
  if (/target-address-not-allowed|AllowedTargets|invalid-calldata|AllowedCalldata/i.test(reason)) return "Vendor is not on the approved list";
  if (/disabled/i.test(reason)) return "Policy was revoked by the owner";
  if (/expired|Timestamp/i.test(reason)) return "Policy has expired";
  return reason;
}

// Monad reserves gas by gas LIMIT, so each agent tx locks about 0.05 MON; keep the agent funded
async function ensureGas() {
  const bal = await pub.getBalance({ address: agent.address });
  if (bal < parseEther("0.2")) {
    const h = await ownerW.sendTransaction({ to: agent.address, value: parseEther("0.5") });
    await pub.waitForTransactionReceipt({ hash: h });
  }
}

async function ensureTreasury() {
  const bal = await pub.getBalance({ address: treasury.address });
  if (bal < parseEther("0.05")) {
    const h = await ownerW.sendTransaction({ to: treasury.address, value: parseEther("0.1") });
    await pub.waitForTransactionReceipt({ hash: h });
  }
}

async function pay(name, amount, note) {
  const e = { t: Date.now(), vendor: name, amount, note, status: "ERROR", hash: null, asset: S.meta.asset || "MON" };
  try {
    await ensureGas();
    const exec = e.asset === "USDC"
      ? createExecution({ target: USDC, value: 0n, callData: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [vendors[name], parseUnits(amount, 6)] }) })
      : createExecution({ target: vendors[name], value: parseEther(amount), callData: "0x" });
    const data = DelegationManager.encode.redeemDelegations({
      delegations: [[S.policy]], modes: [ExecutionMode.SingleDefault], executions: [[exec]],
    });
    // dry-run first so we can read WHY the contract would refuse (the real tx still goes onchain as proof)
    let reason = null;
    try { await pub.call({ account: agent.address, to: DM, data, gas: 500000n }); }
    catch (err) {
      const msg = err.shortMessage || err.message || "";
      if (/revert/i.test(msg)) reason = msg.replace(/^.*reason:\s*/i, "").replace(/\.$/, "");
    }
    e.hash = await agentW.sendTransaction({ to: DM, data, gas: 500000n });
    const r = await pub.waitForTransactionReceipt({ hash: e.hash });
    e.status = r.status === "success" ? "PAID" : "BLOCKED";
    if (e.status === "BLOCKED") {
      e.reason = reason;
      e.why = why(reason);
      // revoked/expired reverts have no readable text, so use the policy state we already know
      if (!reason || /unknown reason/i.test(reason)) {
        if (S.meta.revoked) e.why = "Policy was revoked by the owner";
        else if (now() > S.meta.expires) e.why = "Policy has expired";
      }
    }
  } catch (err) { e.note += " | " + (err.shortMessage || err.message); }
  S.log.unshift(e); S.log = S.log.slice(0, 100); save();
}

// Scripted demo agent (simulated scenario; the guardrail is what is real)
const PLAN = [
  ["DataFeed Co", "0.004", "buys market data"],
  ["DataFeed Co", "0.004", "buys market data"],
  ["ShadyAPI", "0.002", "unknown vendor offers cheaper data"],
  ["DataFeed Co", "0.05", "bulk purchase (simulated prompt injection)"],
  ["DataFeed Co", "0.004", "buys market data"],
];
let running = false;
async function runAgent() {
  if (running) return;
  running = true;
  try { if ((S.meta.asset || "MON") === "MON") await ensureTreasury(); for (const [v, a, n] of PLAN) await pay(v, a, n); } finally { running = false; }
}

async function kill() {
  const calldata = DelegationManager.encode.disableDelegation({ delegation: S.policy });
  const d = createDelegation({
    to: owner.address, from: treasury.address, environment: treasury.environment,
    scope: { type: "functionCall", targets: [DM], selectors: [calldata.slice(0, 10)] }, salt: salt(),
  });
  const admin = { ...d, signature: await treasury.signDelegation({ delegation: d }) };
  const data = DelegationManager.encode.redeemDelegations({
    delegations: [[admin]], modes: [ExecutionMode.SingleDefault],
    executions: [[createExecution({ target: DM, value: 0n, callData: calldata })]],
  });
  const h = await ownerW.sendTransaction({ to: DM, data, gas: 500000n });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error("kill tx reverted");
  S.meta.revoked = true;
  S.log.unshift({ t: Date.now(), vendor: "-", amount: "-", note: "owner revoked the policy", status: "REVOKED", hash: h });
  save();
}

if (!S.policy) await makePolicy("0.02", 120);

// ---- one dashboard for everyone: every control is public, so each visitor and each day is capped ----
const DAILY = Number(process.env.DEMO_DAILY || 30), COOLDOWN = 20000;
let day = { d: "", n: 0 };
const lastBy = new Map(), lastPolicy = new Map();
const today = () => new Date().toISOString().slice(0, 10);
const left = () => Math.max(0, DAILY - (day.d === today() ? day.n : 0));

async function gate(req, res, next) { // actions that cost the owner testnet gas
  if (day.d !== today()) day = { d: today(), n: 0 };
  if (running) return res.status(429).json({ error: "The agent is mid-run. Try again in a few seconds" });
  if (Date.now() - (lastBy.get(req.ip) || 0) < COOLDOWN) return res.status(429).json({ error: "Please wait a few seconds between actions" });
  if (day.n >= DAILY) return res.status(429).json({ error: "Daily action limit reached. Try again tomorrow" });
  if ((await pub.getBalance({ address: owner.address })) < parseEther("1.5")) return res.status(503).json({ error: "Paused: the owner wallet is low on testnet MON" });
  lastBy.set(req.ip, Date.now()); day.n++;
  next();
}
function light(req, res, next) { // policy creation is free, just stop rapid-fire clicks
  if (Date.now() - (lastPolicy.get(req.ip) || 0) < 5000) return res.status(429).json({ error: "Slow down a moment" });
  lastPolicy.set(req.ip, Date.now());
  next();
}

// ---- api ----
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static("public"));

app.get("/api/state", async (_req, res) => {
  const bal = async (a) => formatEther(await pub.getBalance({ address: a }));
  const m = S.meta;
  const status = m.revoked ? "REVOKED" : now() > m.expires ? "EXPIRED" : "ACTIVE";
  res.json({
    status, cap: m.cap, expires: m.expires, running, asset: m.asset || "MON", left: left(),
    treasuryAddress: treasury.address, agent: agent.address,
    allowed: { "DataFeed Co": vendors["DataFeed Co"] },
    treasuryBalance: await bal(treasury.address),
    treasuryUsdc: formatUnits(await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [treasury.address] }), 6),
    log: S.log,
  });
});

app.post("/api/agent/run", gate, async (_req, res) => {
  if ((S.meta.asset || "MON") === "USDC") {
    const u = await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [treasury.address] });
    if (u < parseUnits("0.05", 6)) return res.status(400).json({ error: "The treasury is out of test USDC. Send some to the address shown on this page" });
  }
  runAgent();
  res.json({ started: true });
});
app.post("/api/kill", gate, async (_req, res) => {
  if (S.meta.revoked) return res.status(400).json({ error: "The policy is already revoked" });
  running = true;
  try { await kill(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.shortMessage || e.message }); }
  finally { running = false; }
});
app.post("/api/policy", light, async (req, res) => {
  const asset = req.body.asset === "USDC" ? "USDC" : "MON";
  const cap = Number(req.body.cap), mins = Number(req.body.minutes);
  if (!(cap >= 0.001 && cap <= 0.1)) return res.status(400).json({ error: "Cap must be between 0.001 and 0.1" });
  if (!(mins >= 1 && mins <= 120)) return res.status(400).json({ error: "Minutes must be between 1 and 120" });
  await makePolicy(String(cap), mins, asset);
  res.json({ ok: true });
});
// owner-only hard reset of the shared feed (visitors use the per-browser Clear log instead)
app.post("/api/log/clear", (req, res) => {
  if (!ADMIN || req.get("x-admin-token") !== ADMIN) return res.status(401).json({ error: "owner only" });
  S.log = []; save(); res.json({ ok: true });
});

// ---- per-user mode: each wallet owns its treasury and policy; the agent holds only a signed permission ----
const ctxS = { net: { chain: monadTestnet, usdc: USDC }, publicClient: pub };
const envOnly = { environment: treasury.environment };
const key = (a) => String(a || "").toLowerCase();
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const busy = new Set();

app.get("/api/config", (_req, res) =>
  res.json({ agent: agent.address, vendor: vendors["DataFeed Co"], shady: vendors["ShadyAPI"], left: left() }));

app.post("/api/u/policy", light, (req, res) => {
  const { treasury: t, delegation, asset, cap, expires, vendor } = req.body || {};
  if (!isAddr(t) || !isAddr(vendor)) return res.status(400).json({ error: "Bad address" });
  if (asset !== "MON" && asset !== "USDC") return res.status(400).json({ error: "Asset must be MON or USDC" });
  if (!delegation || key(delegation.delegator) !== key(t) || key(delegation.delegate) !== key(agent.address))
    return res.status(400).json({ error: "The policy must be signed by this treasury for the demo agent" });
  S.users[key(t)] = { treasury: t, vendor, log: [], policy: { delegation, asset, cap: String(cap), expires: Number(expires), revoked: false } };
  save();
  res.json({ ok: true });
});

app.get("/api/u/:addr", (req, res) => {
  const u = S.users[key(req.params.addr)];
  if (!u) return res.json({ exists: false });
  const p = u.policy;
  res.json({
    exists: true, asset: p.asset, cap: p.cap, expires: p.expires, vendor: u.vendor, revoked: p.revoked,
    status: p.revoked ? "REVOKED" : now() > p.expires ? "EXPIRED" : "ACTIVE",
    delegation: p.delegation, log: u.log, busy: busy.has(key(req.params.addr)),
  });
});

app.post("/api/u/run", gate, async (req, res) => {
  const t = key(req.body?.treasury), u = S.users[t];
  if (!u) return res.status(404).json({ error: "Create a policy first" });
  if (busy.has(t)) return res.status(429).json({ error: "Your agent is already running" });
  const bal = await B.balances(ctxS, u.treasury);
  const have = Number(u.policy.asset === "USDC" ? bal.usdc : bal.mon);
  if (have < 0.05) return res.status(400).json({ error: "Your treasury needs at least 0.05 " + u.policy.asset + " for the demo. Send some to it" });
  busy.add(t);
  res.json({ started: true });
  try {
    await ensureGas();
    const plan = [
      [u.vendor, "0.004", "buys market data"],
      [u.vendor, "0.004", "buys market data"],
      [vendors["ShadyAPI"], "0.002", "unknown vendor offers cheaper data"],
      [u.vendor, "0.05", "bulk purchase (simulated prompt injection)"],
      [u.vendor, "0.004", "buys market data"],
    ];
    for (const [to, amount, note] of plan) {
      const r = await B.pay(ctxS, envOnly, u.policy, agentW, { to, amount });
      u.log.unshift({ t: Date.now(), vendor: to === u.vendor ? "your approved vendor" : "an unknown vendor", amount, asset: u.policy.asset, note, status: r.status, hash: r.hash, why: r.why });
      u.log = u.log.slice(0, 100);
      save();
    }
  } finally { busy.delete(t); }
});

// cosmetic label only: the chain decides whether payments are allowed
app.post("/api/u/revoked", light, (req, res) => {
  const u = S.users[key(req.body?.treasury)];
  if (u) {
    u.policy.revoked = true;
    u.log.unshift({ t: Date.now(), vendor: "-", amount: "-", note: "owner revoked the policy", status: "REVOKED", hash: req.body?.hash || null });
    save();
  }
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log("Dashboard on port", process.env.PORT || 3000));
