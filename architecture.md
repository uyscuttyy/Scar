# SCAR Architecture (as built)

## Stack
- Backend: Python FastAPI + `sibyl-memory-client` 0.8.1 + `virtuals-acp`
  0.3.23. Project `.venv` (uv). Run: `SCAR_DB=... .venv/bin/python -m
  uvicorn src.app:app --port 8000`. API routes registered before the
  static mount. Serves the frontend static UI and all memory/quote/
  decision/consult/history APIs.
- Frontend: static Home/Trade/Decision/Your Scars/Settings (no build
  step), `window.ethereum` wallet with EIP-6963 provider picker,
  backend-built swap calldata signed in-wallet. Centered single column,
  max-w-72rem, tonal bands instead of divider lines, mobile stacking.
- Chain: Base Sepolia (chain id 84532), RPC https://sepolia.base.org,
  explorer https://sepolia.basescan.org.
- Swap path: on-chain Uniswap v3 QuoterV2 `quoteExactInputSingle` via
  `eth_call` (server side), execution via SwapRouter02 `exactInputSingle`
  signed by the user's wallet. Backend `encode_swap_call` output verified
  byte-identical to a real mined swap.
- QuoterV2 takes a STRUCT (v3-periphery >=1.3):
  `quoteExactInputSingle((address,address,uint256,uint24,uint160))` with
  field order tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96.
  `get_best_quote` checks factory pool existence per tier
  (500/3000/10000/100) and returns the best amountOut. Price impact is
  measured, not guessed: quoted rate vs pool slot0 spot rate; unreadable
  spot => impact omitted (None), never fabricated.
- Single source of chain truth: `src/uniswap.py` (addresses, chain id,
  tiers, factory). `src/app.py` imports from it. No LLM anywhere.
  Decision engine is deterministic Python (`engine.py`).

## Verified contract addresses (Base Sepolia)
- WETH: 0x4200000000000000000000000000000000000006
- USDC (Circle official): 0x036CbD53842c5426634e7929541eC2318f3dCF7e (6 decimals)
- UniswapV3Factory: 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
- QuoterV2: 0xC5290058841028F1614F3A6F0F5816cAd0df5E27
- SwapRouter02: 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4
- UniversalRouter: 0x492E6456D9528771018DeB9E87ef7750EF184104
- Permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3

## Sibyl integration (real, from installed SDK source)
- `MemoryClient.local(path, tenant_id=<wallet>)`. One SQLite file;
  wallet isolation = `tenant_id` = lowercase wallet address.
- Writes: `set_entity("scar_swap", name, body)` for memories,
  `write_event(acted=..., extra=...)` for journal (POST /record).
- Reads: `list_entities("scar_swap")` (+ `search` available).
- Management: `archive_entity` (recoverable prune), `delete_entity`.
- Availability: any `SibylMemoryError`/`StorageError`/open failure on a
  required path => 503/513-style DENY SIBYL_UNAVAILABLE, zero tx.
  Health probe: open DB + `list_entities(limit=1)`.
- What Sibyl does NOT provide (implemented in Scar, not pretended):
  importance ranking, condition similarity, TTL/expiry, numeric matching.

## Virtuals ACP integration (real wiring, advisory)
- SDK: `virtuals-acp` 0.3.23, chain config `BASE_SEPOLIA_CONFIG_V2`
  (base-sepolia, 84532). Buyer flow implemented in `src/specialist.py`:
  build client -> `browse_agents(keyword)` -> `initiate_job(provider,
  service_requirement, fare)` -> poll `get_job_by_onchain_id` until
  COMPLETED or timeout -> parse provider memo into
  {risk, recommended_max_amount, rationale}.
- Live discovery proven against the production ACP API (HTTP 200, real
  agents returned). Client construction validates the agent smart-wallet
  is deployed on-chain, so a live job genuinely requires a registered
  agent: VIRTUALS_AGENT_WALLET_ADDRESS, VIRTUALS_WALLET_PRIVATE_KEY,
  VIRTUALS_ENTITY_ID (none configured here).
- Unconfigured/failing/slow specialist => explicit unavailable codes
  (SPECIALIST_UNCONFIGURED / NONE_FOUND / TIMEOUT / ERROR); Scar's
  deterministic decision stands. The assessment can only refine the
  safer suggestion, never authorize. Endpoints: GET /specialist/status,
  POST /consult. UI: "Ask a specialist agent" on uncertain (SAFER_TERMS
  without blocking memory) decisions.

## Decision loop
Quote (real QuoterV2) -> build situation -> REQUIRED Sibyl retrieval
-> deterministic compare (same pair+direction+amount bucket+slippage
within tolerance+previous BAD/FAILED) -> ALLOW / DENY / SAFER_TERMS.
Uncertain (SAFER_TERMS, no memory) may consult the ACP specialist;
Scar makes the final call. `/swap` re-evaluates server-side on live
conditions: non-ALLOW => 403, zero calldata. ALLOW returns unsigned
calldata (+ router approval data) for in-wallet signing; receipt status
accepts 1/'0x1'/'0x01'/true; outcome is evaluated and important
experiences are written back to that wallet's tenant.

## Failure behavior
- Sibyl down => DENY SIBYL_UNAVAILABLE, zero transaction (evaluate 200
  with DENY code, /swap 503, /record 503 with fail_closed).
- Specialist down => Scar decides alone, UI says so.
- RPC down => /quote and /swap 500 with message, no fabricated values.
