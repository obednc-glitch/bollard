// Bollard core: give an AI agent a budget the blockchain enforces.
// The agent never holds funds. It holds a signed permission (a delegation).
// Built on MetaMask's Smart Accounts Kit. Wallet-agnostic: pass any viem account.

import {
  createPublicClient, createWalletClient, http, parseEther, parseUnits, formatEther, formatUnits,
  pad, encodeFunctionData, numberToHex,
} from "viem";
import { monadTestnet } from "viem/chains";
import {
  Implementation, toMetaMaskSmartAccount, createDelegation, createExecution, ExecutionMode,
} from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";

// Add a mainnet entry only after verifying its USDC address and explorer.
export const NETWORKS = {
  "monad-testnet": {
    chain: monadTestnet,
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3", // Circle USDC, 6 decimals
    explorerTx: "https://testnet.monadvision.com/tx/",
  },
};

const GAS = 500000n; // Monad reserves gas by gas limit, so always send an explicit limit
const ERC20 = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];
const now = () => Math.floor(Date.now() / 1000);
const salt = () => numberToHex(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));

export function connect(network = "monad-testnet") {
  const net = NETWORKS[network];
  if (!net) throw new Error("Unknown network: " + network);
  const publicClient = createPublicClient({ chain: net.chain, transport: http() });
  const wallet = (account) => createWalletClient({ account, chain: net.chain, transport: http() });
  return { net, publicClient, wallet };
}

// ---- treasury: a smart account owned by the user, derived from their wallet ----
export const getTreasury = (ctx, ownerAccount) =>
  toMetaMaskSmartAccount({
    client: ctx.publicClient, implementation: Implementation.Hybrid,
    deployParams: [ownerAccount.address, [], [], []], deploySalt: "0x", signer: { account: ownerAccount },
  });

export async function deployTreasury(ctx, treasury, ownerWallet) {
  const code = await ctx.publicClient.getCode({ address: treasury.address });
  if (code && code !== "0x") return null; // already deployed
  const { factory, factoryData } = await treasury.getFactoryArgs();
  const hash = await ownerWallet.sendTransaction({ to: factory, data: factoryData });
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function balances(ctx, address) {
  const mon = await ctx.publicClient.getBalance({ address });
  const usdc = await ctx.publicClient.readContract({ address: ctx.net.usdc, abi: ERC20, functionName: "balanceOf", args: [address] });
  return { mon: formatEther(mon), usdc: formatUnits(usdc, 6) };
}

// ---- policy: total budget + one approved vendor + expiry ----
const budgetScope = (ctx, asset, amount) =>
  asset === "USDC"
    ? { type: "erc20TransferAmount", tokenAddress: ctx.net.usdc, maxAmount: parseUnits(amount, 6) }
    : { type: "nativeTokenTransferAmount", maxAmount: parseEther(amount) };

export async function createPolicy(ctx, treasury, { agent, vendor, asset = "MON", cap, ttlSeconds = 3600 }) {
  const expires = now() + ttlSeconds;
  const d = createDelegation({
    to: agent, from: treasury.address, environment: treasury.environment,
    scope: budgetScope(ctx, asset, cap),
    caveats: [
      // USDC calls go to the token, so pin the recipient inside the transfer calldata
      asset === "USDC"
        ? { type: "allowedCalldata", startIndex: 4, value: pad(vendor, { size: 32 }) }
        : { type: "allowedTargets", targets: [vendor] },
      { type: "timestamp", afterThreshold: now() - 300, beforeThreshold: expires },
    ],
    salt: salt(),
  });
  const signature = await treasury.signDelegation({ delegation: d });
  return { delegation: { ...d, signature }, asset, cap, expires };
}

// ---- shared plumbing ----
function transfer(ctx, asset, to, amount) {
  return asset === "USDC"
    ? createExecution({ target: ctx.net.usdc, value: 0n, callData: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, parseUnits(amount, 6)] }) })
    : createExecution({ target: to, value: parseEther(amount), callData: "0x" });
}

async function redeem(ctx, treasury, delegation, execution, wallet) {
  const to = treasury.environment.DelegationManager;
  // Monad checks balance against gas limit x max fee, so a low wallet fails with a cryptic RPC error. Say it plainly.
  const price = await ctx.publicClient.getGasPrice();
  if ((await ctx.publicClient.getBalance({ address: wallet.account.address })) < GAS * price * 2n)
    throw new Error("Wallet is low on MON for gas. Send some to " + wallet.account.address);
  const data = DelegationManager.encode.redeemDelegations({
    delegations: [[delegation]], modes: [ExecutionMode.SingleDefault], executions: [[execution]],
  });
  let reason = null; // dry-run first to read why the contract would refuse
  try { await ctx.publicClient.call({ account: wallet.account.address, to, data, gas: GAS }); }
  catch (err) {
    const msg = err.shortMessage || err.message || "";
    if (/revert/i.test(msg)) reason = msg.replace(/^.*reason:\s*/i, "").replace(/\.$/, "");
  }
  const hash = await wallet.sendTransaction({ to, data, gas: GAS }); // the real tx is the onchain proof
  const r = await ctx.publicClient.waitForTransactionReceipt({ hash });
  return { ok: r.status === "success", hash, reason };
}

async function selfDelegation(treasury, ownerAddress, scope) {
  const d = createDelegation({ to: ownerAddress, from: treasury.address, environment: treasury.environment, scope, salt: salt() });
  return { ...d, signature: await treasury.signDelegation({ delegation: d }) };
}

export function explain(reason, state = {}) {
  if (reason && !/unknown reason/i.test(reason)) {
    if (/allowance-exceeded/i.test(reason)) return "Would exceed the total budget";
    if (/target-address-not-allowed|AllowedTargets|invalid-calldata|AllowedCalldata/i.test(reason)) return "Vendor is not on the approved list";
    if (/disabled/i.test(reason)) return "Policy was revoked by the owner";
    if (/expired|Timestamp/i.test(reason)) return "Policy has expired";
    return reason;
  }
  if (state.revoked) return "Policy was revoked by the owner";
  if (state.expires && now() > state.expires) return "Policy has expired";
  return "Rejected by policy";
}

// ---- agent side: every payment goes through the policy ----
export async function pay(ctx, treasury, policy, agentWallet, { to, amount }) {
  try {
    const r = await redeem(ctx, treasury, policy.delegation, transfer(ctx, policy.asset, to, amount), agentWallet);
    return { status: r.ok ? "PAID" : "BLOCKED", hash: r.hash, reason: r.reason, why: r.ok ? null : explain(r.reason, policy) };
  } catch (err) {
    const msg = err.shortMessage || err.message;
    return { status: "ERROR", hash: null, reason: msg, why: /low on MON/.test(msg) ? "The agent wallet is low on MON for gas" : null };
  }
}

// ---- owner side ----
export async function revoke(ctx, treasury, policy, ownerWallet) {
  const DM = treasury.environment.DelegationManager;
  const calldata = DelegationManager.encode.disableDelegation({ delegation: policy.delegation });
  const admin = await selfDelegation(treasury, ownerWallet.account.address, { type: "functionCall", targets: [DM], selectors: [calldata.slice(0, 10)] });
  const r = await redeem(ctx, treasury, admin, createExecution({ target: DM, value: 0n, callData: calldata }), ownerWallet);
  if (!r.ok) throw new Error("revoke reverted: " + (r.reason || "unknown"));
  policy.revoked = true;
  return r.hash;
}

// Take funds back out of the treasury. The owner signs a one-shot permission to themselves.
export async function withdraw(ctx, treasury, ownerWallet, { asset = "MON", amount, to }) {
  const owner = ownerWallet.account.address;
  const d = await selfDelegation(treasury, owner, budgetScope(ctx, asset, amount));
  const r = await redeem(ctx, treasury, d, transfer(ctx, asset, to || owner, amount), ownerWallet);
  if (!r.ok) throw new Error("withdraw reverted: " + (r.reason || "unknown"));
  return r.hash;
}
