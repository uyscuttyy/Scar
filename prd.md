# SCAR PRD (implementation as built)

Scar is a wallet-connected swap agent on Base Sepolia. It helps a user swap
via real Uniswap v3 quotes while remembering the conditions and outcomes of
that wallet's previous swaps, and refuses to repeat harmful conditions.

No LLM. Deterministic decision engine. Real Sibyl SDK storage. Fail closed.
Virtuals ACP specialist consultation is real wiring, advisory only, and
requires a registered agent (unconfigured by default).

## Screens
Home, Trade, SCAR Decision, Your Scars, Settings. Single static frontend
(no build step), `window.ethereum` wallet with EIP-6963 discovery,
backend-built swap calldata signed in-wallet. Centered single-column
layout, max-w-72rem.

## User flow
Connect wallet -> Trade (amount, real quote, current conditions) ->
Review with Scar -> Decision (ALLOW / DENY / SAFER_TERMS, with the
relevant memory and only the conditions that matter) -> ALLOW: confirm,
sign, approval if needed, Uniswap tx on Base Sepolia, receipt, real tx
hash, automatic experience evaluation ("Scar learned something").

## Decision contract
- Input: wallet, pair, direction, amount, slippage_bps (live quote),
  impact_bps (measured vs pool slot0).
- ALLOW: no relevant BAD/FAILED memory and effective signal < 400bps.
- DENY + zero tx: same pair+direction+amountBucket, BAD/FAILED memory
  within 150bps, current effective signal >= 400bps. Response cites the
  blocking memory and includes a computed safer amount.
- SAFER_TERMS + zero tx: effective signal >= 400bps with no matching bad
  memory. Includes a computed safer amount; "Try safer" re-runs fresh
  quote -> situation -> Sibyl -> evaluation.
- Effective signal = max(slippage, impact). Same pair alone never denies.
- `/swap` re-evaluates server-side on live conditions before building ANY
  calldata: non-ALLOW returns 403 with the decision and zero transaction
  data, so no frontend bypass can submit a denied trade.
- Any Sibyl error: DENY SIBYL_UNAVAILABLE. No fallback store.
- Uncertain path: SAFER_TERMS with no blocking memory offers "Ask a
  specialist agent" (Virtuals ACP). The assessment is advisory only and
  can only refine the safer suggestion, never authorize a trade. Scar
  remains the final decision-maker.

## Memory contract
- One SQLite file (SCAR_DB). Tenant = lowercase wallet. Verified isolated.
- record_experience: importance score (FAILED+50/BAD+40/GOOD+5,
  slip>=500 +25, >=200 +10, repeat +20, age decay, decision pin),
  journal always, entity only if importance >= 30, prune over 50 by
  archiving lowest importance.
- Supersede: only a GOOD that re-tests the bad conditions (same
  pair+direction+bucket, conditions at least as harsh) retires a blocker.
  A small easy GOOD never retires a large harsh FAILED.
- Never fabricate missing chain fields.

## Out of scope (not built)
Live Virtuals job execution (needs registered agent credentials, see
architecture.md). On-chain history reader (history = meaningful Sibyl
experiences, not a tx archive). Production build (no bundler; static
page + FastAPI is the whole app).
