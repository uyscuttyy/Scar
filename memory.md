# SCAR Memory Design (as built, sibyl-memory-client 0.8.1)

## Tenancy
- `tenant_id` = lowercase wallet address (`0x...`).
- Every table carries `tenant_id`; every SDK query filters on it.
  Verified: wallet B unaffected by wallet A's BAD memory.
- New wallet => new tenant partition on first write. Returning wallet =>
  `set_tenant` + existing rows returned. Memory belongs to the wallet.

## Schema usage (only free-tier primitives)
- WARM entity `category="scar_swap"`, `name=<txHash or uuid>`:
  body = {wallet, pair, direction, amount, amountBucket, quotedRate,
  minRate, execRate, slippageBps, impactBps, outcome (GOOD/BAD/FAILED),
  reason, ts, txHash, importance, supersededBy?}
- COLD journal `write_event(acted=[...], extra={...})` per evaluated swap.
- FTS5 `search()` is keyword retrieval aid only, never the decider.
- No invented fields: missing chain data is omitted, never fabricated.

## Importance scoring (deterministic, in engine.py: Sibyl has no ranker)
Score from available evidence only:
- FAILED +50, BAD +40, GOOD +5; slippage>=500bps +25, >=200 +10;
  repeated same-pair bad +20; recency decay -1 per 30 days (floor kept
  if it still changed a decision); decision-changing memory pinned.
- Store threshold: importance >= 30. Below => journal only, not an entity.
  Verified: GOOD at 50/15bps scored 25, journaled, not stored.

## Condition-aware matching (Sibyl has no similarity engine)
- Candidate filter: same pair + same direction + same amountBucket.
- Similarity: |currentSlip - memSlip| <= 150bps via
  `eff_slip >= mem_slip - 150` AND current effective signal >= 400bps
  AND memory outcome in (BAD, FAILED) AND not superseded.
- Same pair with better conditions => ALLOW. Never block on pair alone.
  Verified: 50 USDC BAD-memory wallet still ALLOWs at 50/15bps.

## Safer suggestions (in engine.py, never hardcoded per trade)
- `suggested_safer_amount`: step down one bucket (large->999,
  medium->99, small->9, dust->half). Smaller size escapes the recorded
  bucket and genuinely lowers price impact.
- Verified: suggestion 9.0 for a denied 50-USDC trade re-evaluates to
  ALLOW (different bucket, low signal).

## Supersede (fixed this build: was over-broad)
- Only a GOOD that re-tests the bad conditions (same pair+direction+
  bucket, GOOD signal >= bad signal - 150bps) sets `supersededBy`.
- Verified: dust-bucket easy GOOD leaves a small-bucket FAILED blocker
  intact (still DENY); same-bucket harsh GOOD retires it (blocker gone).
- Old + contradicted/redundant/never-deciding => archive; old +
  still-deciding => keep (prune keeps max 50, lowest importance first).

## Failure semantics (load-bearing)
- Required ops: pre-swap retrieval (`list_entities`) and post-swap
  write (`set_entity`/`write_event`). Any raise or open failure =>
  DENY SIBYL_UNAVAILABLE, zero transaction. Verified with broken store.
- No fallback store. Deleting the DB file makes health report
  unavailable and decisions fail closed.
