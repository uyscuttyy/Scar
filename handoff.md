# SCAR handoff (hostile audit)

## What was repaired/rebuilt
- Previous agent: 6 files, uninstallable (no venv, fastapi/sibyl missing),
  /health 404 (static mount registered before API routes), write-via-GET,
  engine without importance/buckets/supersede/prune, no docs beyond two md.
- This pass: project `.venv` (sibyl 0.8.1, fastapi, uvicorn); mount order
  fixed; engine rewritten per memory.md; POST /record added; journal
  always written; prune + supersede implemented; prd/project-plan/handoff
  written.

## What actually works (executed, not claimed)
- `POST /record` BAD 480bps -> importance 50, stored + journaled.
- Similar 450bps -> DENY citing memory; better 80bps -> ALLOW.
- Other wallet same conditions -> SAFER_TERMS (isolation proven).
- Restart -> DENY persists (SQLite durable).
- Broken store -> DENY SIBYL_UNAVAILABLE, zero tx.
- /health, /quote_ref, / return 200. Static page has no JS.

## Blockers / not done
- No wallet-connect UI; no live Uniswap quote call; no signed tx path;
  no on-chain history reader; no production build step (none needed yet).
- `requirements.txt` lists web3 but it is not installed or imported.

## 2026-09-08 update (quote path fixed, UI built)
- Real QuoterV2 quotes live: struct encoding fixed, best-tier routing,
  measured price impact from slot0 spot. 50 USDC -> 0.0254 WETH, fee
  500, impact 387bps (verified via POST /quote).
- Decision engine now uses max(slippage, impact) as the condition
  signal; old slippage-only memories still evaluate identically
  (impact defaults 0).
- POST /swap builds real SwapRouter02 calldata (selector 0x04e45aaf).
  SwapRouter struct encoding unverified until a real wallet signing test.
- Frontend built: static/index.html + css/app.css + js/app.js served at
  / with /js and /css paths fixed. Eval/record/history field names match.
- Verified: record BAD -> DENY similar, ALLOW better, isolation,
  restart persistence, fail-closed on broken store. Browser test with a
  real wallet + signed tx still pending.

## 2026-09-08 E2E PROOF (real Base Sepolia txs, wallet 0x9A67…8123)
- Approval fix (traced): this SwapRouter02 pulls input via direct
  transferFrom with the router as spender — wallet->router ERC20
  approval is required, Permit2 alone reverts (STF). /swap now returns
  `approval` calldata; frontend checks allowance and prompts approval
  first. e2e_swap.py / e2e_fail.py are the runnable proofs.
- GOOD swap: 1 USDC -> WETH, ALLOW -> approve + exactInputSingle mined
  status 1, block 46563978,
  tx 0x1bcbd67b57a050ff294369570834e7f3e151286c7903b00ae4001b35fb03b9f5.
  Recorded GOOD importance 5 -> journal only (correct: not stored).
- FAILED swap: rigged min (2x quote) reverted on-chain status 0, block
  46563993,
  tx 0x5e33e4da26d9e0c13acb27f98dd8a05696c6570045880fbcc8319f60835aae8c.
  Recorded FAILED importance 50 -> stored.
- Condition-aware: same-bucket bad conditions -> DENY citing the real
  txHash, zero tx; same pair good conditions -> ALLOW. DENY survives
  server restart. History returns the FAILED memory.

## Run
SCAR_DB=/tmp/scar_memory.db .venv/bin/python -m uvicorn src.app:app \
  --host 127.0.0.1 --port 8000

## Do not trust without re-running
Re-run the curl sequence in project-plan phases 8-13 before any demo.
