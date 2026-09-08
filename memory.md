# SCAR Memory Design (researched against sibyl-memory-client 0.8.1)

## Tenancy
- `tenant_id` = lowercase wallet address (`0x...`). Safe: identifier rules
  reject only control chars, `..`, and `< > | ; " \`` — none appear in addresses.
- Every table carries `tenant_id`; every SDK query filters on it.
  Verified by smoke test (0xAAA vs 0xBBB fully isolated).
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

## Importance scoring (deterministic, in engine.py — Sibyl has no ranker)
Score from available evidence only:
- FAILED +50, BAD +40, GOOD +5; slippage>=500bps +25, >=200 +10;
  repeated same-pair bad +20; recency decay -1 per 30 days (floor kept
  if it still changed a decision); decision-changing memory pinned.
- Store threshold: importance >= 30. Below => journal only, not an entity.

## Condition-aware matching (Sibyl has no similarity engine)
- Candidate filter: same pair + same direction + same amountBucket.
- Similarity: |currentSlip - memSlip| <= 150bps AND currentSlip >= 200bps
  AND memory outcome in (BAD, FAILED) AND not superseded AND not decayed.
- Same pair with better conditions (slippage below 200bps or 150bps+
  better than the bad memory) => ALLOW. Never block on pair alone.

## Decay / pruning (Sibyl has no TTL; Scar manages its set)
- Keep smallest useful set: on write, if set > 50 entities, archive lowest
  importance first (recoverable `archive_entity`), never hard-delete except
  via explicit user/test delete.
- Supersede: a newer GOOD under previously-bad conditions marks the old
  memory `supersededBy` (entity update) so it stops blocking.
- Age is one signal only: old + contradicted/redundant/never-deciding =>
  archive; old + still-deciding => keep.

## Failure semantics (load-bearing)
- Required ops: pre-swap retrieval (`list_entities`/`search`) and post-swap
  write (`set_entity`/`write_event`). Any raise (`StorageError`,
  `CapExceededError`, `TierVerificationError`, open failure, DB file
  missing/unreadable) => 503 SIBYL_UNAVAILABLE => UI refuses swap.
- No fallback store. Deletion test: deleting the wallet's entities (UI
  test control or `delete_entity`) makes the next decision path fail
  closed until memory is writable/readable again.
- Known limits: 5MB free-tier cap (`CapExceededError`) counts as
  unavailable; `learn()`/`lint()` gated (`TierGateError`) and unused;
  FTS tenant filter is post-filter (audit-noted) — isolation verified
  empirically and relied upon as implemented, not as index guarantee.
