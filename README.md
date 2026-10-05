# Bollard

**Spending limits for AI agents, enforced on-chain.**

You give an AI agent a budget, one approved vendor and an expiry date. The agent can spend only inside those limits. It never holds your funds, and you can revoke it or withdraw at any time.

Live demo (Monad testnet): https://bollard-4ek5.onrender.com

## The problem

An agent that can pay for things can also be tricked into paying too much, or paying the wrong party. A prompt injection or a bug should not be able to empty a wallet. Limits that live only in the agent's own code or in a server are only as safe as that code.

## How Bollard works

1. **Your wallet owns a treasury.** Connect a wallet and Bollard derives a treasury for it, a MetaMask smart account. You fund it by sending testnet MON or test USDC to its address.
2. **You sign a policy.** Choose a budget in MON or USDC, one approved vendor and how long it lasts. The signed policy is a delegation, and it is the only permission the agent holds.
3. **The agent pays within the policy.** Each payment is checked on-chain against the policy. Anything outside it is rejected, and Bollard shows the reason in plain English.
4. **You stay in control.** Revoke the policy to stop the agent immediately, or withdraw funds from your treasury whenever you like.

The chain decides what is allowed. The server and the page only display the result.

## Plain-English reasons

When a payment is blocked, the page says why:

- Vendor is not on the approved list
- Would exceed the total budget
- Policy was revoked by the owner

## Proof on Monad testnet

These transactions come from a run of the live demo with a USDC policy.

| What happened | Transaction |
| --- | --- |
| Treasury deployed | [0x8d2e3046...4965dc](https://testnet.monadvision.com/tx/0x8d2e30464c9892959198a1230783f0cfc764627e5c7290867ac6d564e14965dc) |
| Agent paid the approved vendor | [0x27f9aeca...522d5b](https://testnet.monadvision.com/tx/0x27f9aeca2f435adcae529173ac5679fdf1dab3b9fe207bc70e8c74fd9e522d5b) |
| Blocked: vendor not on the approved list | [0xc14aa780...6837be](https://testnet.monadvision.com/tx/0xc14aa78080e6d1be6a68a35863d793b8cb2572386db072c1313ebea2ec6837be) |
| Blocked: would exceed the total budget | [0xd13ba249...cccfc07](https://testnet.monadvision.com/tx/0xd13ba249ddb2573568b09b0b99bbd423ed546d756189392deab73c307cccfc07) |
| Owner revoked the policy | [0x339e7a1c...d02e408b](https://testnet.monadvision.com/tx/0x339e7a1caf39f50f9e959dd07b30288d5af6ad1522834a56f6a2f290d02e408b) |

The core library also has a test suite that ran 9 of 9 on Monad testnet. It covers MON and USDC policies, vendor and budget blocks with reasons, revoke and withdraw.

## Try it

1. Open the demo and connect a wallet on Monad testnet.
2. Deploy your treasury and send it some testnet MON or USDC. The page links to the faucets.
3. Sign a policy: pick MON or USDC, a budget, a duration and the approved vendor address.
4. Press **Run agent**. The demo agent makes five purchases: two valid ones, one to an unknown vendor, one oversized bulk purchase, and one that no longer fits the budget.
5. Press **Revoke policy** and run the agent again. Every attempt is blocked.
6. Use **Withdraw** to take funds back out of your treasury.

The demo agent needs your treasury to hold at least 0.05 of the policy's asset. The free host sleeps when idle, so the first load can take up to a minute.

## What it is built on

- No custom contracts. Policies are delegations from the [MetaMask Smart Accounts Kit](https://docs.metamask.io/smart-accounts-kit/), and limits are enforced by its caveats.
- Monad testnet, with MON and Circle testnet USDC (`0x534b2f3A21130d7a60830c2Df862319e593943A3`).
- `bollard-core.mjs` is a small library that holds the policy and payment logic. The server and the wallet page both use it, so other projects and agents can plug it in.
- Node.js and Express for the server, plain HTML and viem for the wallet page.

## Run it yourself

```
npm install
PORT=3100 ADMIN_TOKEN=demo node server.mjs
```

For a hosted deploy, set these environment variables:

- `OWNER_KEY` and `AGENT_KEY`: throwaway testnet private keys
- `VENDOR_A` and `VENDOR_B`: vendor addresses
- `ADMIN_TOKEN`: any string you choose

Locally the server falls back to a `keys.json` file that is never committed. To run the library tests, use `node bollard-test-suite.mjs`.

## Limits of this version

- Testnet only. The code has not been audited and should not hold real funds.
- One approved vendor per policy.
- The demo agent is scripted. It shows the limits working but does not make decisions of its own.
- Each agent transaction needs about 0.1 MON of gas in the agent wallet, because Monad charges gas by the gas limit.
- Demo history on the free host resets when the service restarts.

## Roadmap

- An MCP server and an npm package, so any agent framework can request and spend within a policy
- A multi-vendor allowlist
- A compliance pre-flight check on the recipient before a payment is sent
- A mainnet checklist and review

## License

MIT
