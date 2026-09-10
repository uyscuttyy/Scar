# SCAR memory implementation notes — how remembering actually works

If you only read one doc before trusting Scar with a trade, make it this
one. It covers what gets remembered, how it changes decisions, and the
guarantees that keep memory load-bearing instead of decorative.

---

## The big idea in one paragraph

Every trade builds a **situation** (pair, direction, amount bucket,
slippage, price impact, wallet). Scar retrieves that wallet's past
**experiences** from Sibyl, compares current conditions against stored
conditions, and decides. After execution, the outcome is scored for
**importance** — only important ones are persisted. Next time, the stored
past votes on the present.

---

## 1. Situations: what Scar looks at

Built in `build_situation()` (`src/engine.py`):

| Field | Example | Why it matters |
|-------|---------|----------------|
| `wallet` | `0x8cc9…` (lowercased) | Tenant ID — memory never crosses wallets |
| `pair` | `USDC-WETH` | Only same-pair memories can block |
| `direction` | `sell` | A bad sell says nothing about a buy |
| `amount` / `amountBucket` | `0.5` / `dust` | Buckets: dust (<10), small (<100), medium (<1000), large |
| `slippage_bps` | `470` | Quoted tolerance, basis points |
| `impact_bps` | `10` | Measured price impact from the live quote |

The decision uses the **effective slip** = worse of quoted slippage and
measured impact. Both are real quote data, never guessed.

## 2. Retrieval: whose past, and how much

- `MemoryClient.local(DB_PATH, tenant_id=wallet.lower())` — one namespace
  per wallet, enforced by the client, not by convention.
- `list_entities(category="scar_swap", limit=100)` pulls the wallet's
  experiences; matching happens in the engine (same pair + direction +
  bucket, outcome BAD/FAILED, not superseded).
- A memory blocks only if current effective slip is within 150 bps of the
  stored bad conditions. Same pair alone never denies — conditions must
  rhyme. A safer (much lower slip/impact) version of a bad trade is allowed.

## 3. Decisions: ALLOW / DENY / SAFER TERMS

In `evaluate()`:

- **DENY** (`REPEAT_BAD_CONDITIONS`) — a stored BAD/FAILED memory matches.
  Response includes the blocking memory *with its txHash*, plus a
  `safer_suggestion` (smaller amount that leaves the bad conditions).
- **SAFER_TERMS** — conditions are harsh (≥400 bps) with no exact memory
  match. Re-quoting at the suggested size can reach ALLOW.
- **ALLOW** (`NO_RELEVANT_MEMORY` or conditions clearly better) — includes
  `tx_submitted` expectations; `/swap` then re-evaluates server-side and
  returns **403 + zero calldata** on anything but ALLOW. The frontend
  cannot bypass this.

## 4. Importance: what earns storage

Scored in `score_importance()` (`src/engine.py`):

| Signal | Points |
|--------|--------|
| Outcome FAILED | +50 |
| Outcome BAD | +40 |
| Outcome GOOD | +5 |
| Slip ≥ 500 bps | +25 |
| Slip ≥ 200 bps | +10 |
| Repeats a known-bad pattern | +20 |
| Decided (went through review) | +15 |
| Age decay | −1 per 30 days |

**Stored if importance ≥ 30** (`STORE_THRESHOLD`), journaled always.
Concretely: a routine success lands ~5–25 (journal-only, invisible on the
scars page — by design), a revert lands ~50+ (stored, blocks next time).
Caps at 50 memories per wallet; beyond that the lowest-importance ones are
archived first.

## 5. Supersede: good runs can retire warnings

A GOOD outcome retires an older BAD/FAILED blocker **only if** it ran under
conditions at least as harsh (same pair/direction/bucket, equal-or-higher
effective slip). An easy win never erases a hard lesson. This is verified
both directions in testing.

## 6. Guarantees a host should know

1. **Wallet isolation** — tenant = lowercased address. Proven: two wallets,
   disjoint histories, no leakage.
2. **Restart survival** — memories live in SQLite (`SCAR_DB`), not RAM.
   Proven: kill server, restart, same wallet, same DENY citing the same txHash.
3. **Fail-closed** — Sibyl error → 503 on evaluate → 403 with zero calldata
   on swap. Memory is on the critical path; remove it and Scar refuses
   experience-aware decisions instead of guessing.
4. **DENY = zero submission** — no calldata, no signature request, nothing
   for the wallet to sign.
5. **Deterministic** — same situation + same memories = same decision. No
   LLM in the loop, no temperature, no vibes.

## 7. What the scars page shows (and hides)

Each card renders the pair + direction, size + bucket, slippage/impact,
timestamp, explorer-linked txHash, plus two generated lines:

- *Why Scar remembers it* — outcome + harshness + importance.
- *How it may affect future decisions* — blocker vs. warning-retirer.

Journal-only trades (routine wins) intentionally never appear. If a user
asks "where did my successful trade go?", the trade page's lilac memory
note already answered at receipt time: *"Routine trade, journaled only.
Nothing painful enough to become a scar."*

## 8. Files to read if you want the source

- `src/engine.py` — situations, matching, scoring, supersede, pruning
  (~230 lines, the whole brain).
- `src/app.py` — `/evaluate`, `/swap` gate, `/record`, `/history`.
- `memory.md` — the original memory spec the engine implements.
- `tests/test_engine.py` — unit checks for the rules above.
