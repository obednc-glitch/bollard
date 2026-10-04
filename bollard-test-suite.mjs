// Exercises bollard-core.mjs end to end on Monad testnet (MON and USDC policies, revoke, withdraw).
import fs from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther } from "viem";
import * as B from "./bollard-core.mjs";

const k = JSON.parse(fs.readFileSync("keys.json", "utf8"));
const owner = privateKeyToAccount(k.owner);
const agent = privateKeyToAccount(k.agent);
const vendorA = privateKeyToAccount(k.vendor).address; // approved
const vendorB = privateKeyToAccount(k.vendor2).address; // not approved

const ctx = B.connect("monad-testnet");
const ownerW = ctx.wallet(owner), agentW = ctx.wallet(agent);
const treasury = await B.getTreasury(ctx, owner);
await B.deployTreasury(ctx, treasury, ownerW);
console.log("Treasury:", treasury.address);

// the agent needs gas money
if ((await ctx.publicClient.getBalance({ address: agent.address })) < parseEther("0.6")) {
  const h = await ownerW.sendTransaction({ to: agent.address, value: parseEther("1") });
  await ctx.publicClient.waitForTransactionReceipt({ hash: h });
}
const start = await B.balances(ctx, treasury.address);
console.log("Treasury balance:", start.mon, "MON,", start.usdc, "USDC");
if (Number(start.mon) < 0.05 || Number(start.usdc) < 0.05) {
  console.log("Treasury needs at least 0.05 MON and 0.05 USDC for this test.");
  process.exit(0);
}

const results = [];
function check(label, got, want, extra = "") {
  const ok = got === want;
  results.push(ok);
  console.log(ok ? "PASS" : "FAIL", "|", label, "->", got, extra);
}

for (const asset of ["MON", "USDC"]) {
  console.log("\n--- " + asset + " policy: cap 0.01, vendor A only ---");
  const policy = await B.createPolicy(ctx, treasury, { agent: agent.address, vendor: vendorA, asset, cap: "0.01" });
  let r = await B.pay(ctx, treasury, policy, agentW, { to: vendorA, amount: "0.004" });
  check(asset + " approved vendor, within cap", r.status, "PAID", r.hash || r.reason);
  r = await B.pay(ctx, treasury, policy, agentW, { to: vendorB, amount: "0.001" });
  check(asset + " unapproved vendor", r.status, "BLOCKED", r.why || r.reason);
  r = await B.pay(ctx, treasury, policy, agentW, { to: vendorA, amount: "0.05" });
  check(asset + " over the cap", r.status, "BLOCKED", r.why || r.reason);

  if (asset === "USDC") {
    console.log("\nOwner revokes the USDC policy...");
    try {
      const h = await B.revoke(ctx, treasury, policy, ownerW);
      console.log("Revoked, tx:", h);
    } catch (e) { console.log("Revoke error:", e.shortMessage || e.message); }
    r = await B.pay(ctx, treasury, policy, agentW, { to: vendorA, amount: "0.001" });
    check("USDC payment after revoke", r.status, "BLOCKED", r.why || r.reason);
  }
}

console.log("\n--- withdraw ---");
for (const [asset, amount] of [["MON", "0.001"], ["USDC", "0.01"]]) {
  const before = Number((await B.balances(ctx, treasury.address))[asset.toLowerCase()]);
  let tx = "";
  try { tx = await B.withdraw(ctx, treasury, ownerW, { asset, amount }); } catch (e) { tx = e.shortMessage || e.message; }
  const after = Number((await B.balances(ctx, treasury.address))[asset.toLowerCase()]);
  const moved = Math.abs(before - after - Number(amount)) < 1e-9;
  check("withdraw " + amount + " " + asset, moved ? "MOVED" : "NOT MOVED", "MOVED", tx);
}

console.log("\nResult:", results.filter(Boolean).length, "of", results.length, "checks passed");
