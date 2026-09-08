# SCAR Architecture (locked, researched)

## Stack
- Backend: Python FastAPI + real `sibyl-memory-client` (verified v0.8.1).
  Project `.venv` (uv). Run: SCAR_DB=... .venv/bin/python -m uvicorn
  src.app:app --port 8000. API routes registered before the static mount
  (mount-first shadowed /health with 404 — fixed).
  Serves the frontend static UI and all memory/quote/history APIs.
- Frontend: single static page (no build step), `window.ethereum` wallet,
  backend-built swap calldata signed in-wallet. Near full-width layout.
- Chain: Base Sepolia (chain id 84532), RPC https://sepolia.base.org,
  explorer https://sepolia.basescan.org.
- Swap path: on-chain Uniswap v3 QuoterV2 `quoteExactInputSingle` via
  `eth_call` (server side), execution via UniversalRouter/SwapRouter02
  signed by the user's wallet. Fallback: Uniswap Trading API
  (`/quote` + `/swap`) which supports Base Sepolia (84532).
- QuoterV2 takes a STRUCT (v3-periphery >=1.3):
  `quoteExactInputSingle((address,address,uint256,uint24,uint160))` with
  field order tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96.
  Flat-arg encoding reverts on-chain — verified live. `get_best_quote`
  checks factory pool existence per tier (500/3000/10000/100) and
  returns the best amountOut. Price impact is measured, not guessed:
  quoted rate vs pool slot0 spot rate; unreadable spot => impact
  omitted (None), never fabricated.
- No LLM anywhere. Decision engine is deterministic Python (`engine.py`).

## Verified contract addresses (Base Sepolia, from Uniswap docs + Circle docs)
- WETH: 0x4200000000000000000000000000000000000006
- USDC (Circle official): 0x036CbD53842c5426634e7929541eC2318f3dCF7e (6 decimals)
- UniswapV3Factory: 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
- QuoterV2: 0xC5290058841028F1614F3A6F0F5816cAd0df5E27
- SwapRouter02: 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4
- UniversalRouter: 0x492E6456D9528771018DeB9E87ef7750EF184104
- Permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3

## Sibyl integration (real, from installed SDK source)
- `MemoryClient.local(path, tenant_id=<wallet>)`. One SQLite file
  (`~/.scar/sibyl/memory.db`); wallet isolation = `tenant_id` = lowercase
  wallet address. Smoke-tested: tenant A invisible to tenant B.
- Writes: `set_entity("scar_swap", name, body)` for memories,
  `write_event(acted=..., extra=...)` for journal (see record_experience
  in src/engine.py; POST /record endpoint).
- Reads: `list_entities("scar_swap")`, `get_entity`, `search(query)`.
- Management: `archive_entity` (recoverable), `delete_entity` (hard).
- Availability: any `SibylMemoryError`/`StorageError`/open failure on the
  required read or write path => backend returns 503 and UI refuses swap
  (fail closed). Health probe: open DB + `list_entities(limit=1)`.
- What Sibyl does NOT provide (implemented in Scar, not pretended):
  importance ranking, condition similarity, TTL/expiry, numeric matching.
  `learn()`/`lint()` are paid-tier gated and Scar never calls them.

## Decision loop
Quote (real QuoterV2) -> build situation -> REQUIRED Sibyl retrieval
-> deterministic compare (same pair+direction+amount bucket+slippage
within tolerance+previous BAD/FAILED) -> ALLOW / DENY / SAFER TERMS.
DENY submits zero transactions. ALLOW returns unsigned calldata for
in-wallet signing; receipt txHash is displayed; outcome is evaluated and
important experiences are written back to that wallet's tenant.

## Sources inspected
- Installed `sibyl-memory-client` 0.8.1 source: `__init__.py`, `client.py`
  (MemoryClient API, tenant validation, cap gate, tier gating),
  `schema.sql` (10 tables + FTS5), `exceptions.py` (typed errors).
- Runtime smoke test: cross-tenant isolation, search, archive verified.
- Uniswap Base Deployments page (contract table), Uniswap swap API docs
  (quote/swap flow, Base Sepolia 84532 supported), Circle USDC addresses
  (Base Sepolia 0x036C...CF7e), Base docs (WETH, RPC, chain id).
- web_extract of github.com/Sibyl-Labs/Sibyl-Memory and docs.sibyllabs.org
  was blocked (403, no key); PyPI metadata + installed source used instead.
