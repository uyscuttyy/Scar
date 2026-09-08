# SCAR PRD (actual implementation)

Scar is a wallet-connected swap agent on Base Sepolia. It helps a user swap
via real Uniswap v3 quotes while remembering the conditions and outcomes of
that wallet's previous swaps, and refuses to repeat harmful conditions.

No LLM. Deterministic decision engine. Real Sibyl SDK storage. Fail closed.

## Screens (current)
1. Single static page describing the product, contract refs, demo links.
   Full Connect/Swap/Decision/History screens are NOT built yet.

## Decision contract
- Input: wallet, pair, direction, amount, slippage_bps (from real quote).
- ALLOW: no relevant BAD/FAILED memory and slippage < 400bps.
- DENY + zero tx: same pair+direction+amountBucket, BAD/FAILED memory within
  150bps, current slippage >= 400bps. Response cites the blocking memory.
- SAFER_TERMS + zero tx: slippage >= 400bps with no matching bad memory.
- Any Sibyl error: DENY SIBYL_UNAVAILABLE. No fallback store.

## Memory contract
- One SQLite file (SCAR_DB). Tenant = lowercase wallet. Verified isolated.
- record_experience: importance score (FAILED+50/BAD+40/GOOD+5,
  slip>=500 +25, >=200 +10, repeat +20, age decay, decision pin),
  journal always, entity only if importance >= 30, prune over 50 by
  archiving lowest importance, GOOD supersedes prior blockers.
- Never fabricate missing chain fields.

## Out of scope (not built)
Wallet signing flow, live QuoterV2 eth_call wiring, on-chain history
reader, Connect/Swap/Decision/History UI, production build (no bundler;
static page + FastAPI is the whole app).
