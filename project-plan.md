# SCAR project plan (as built)

1. Product foundation — DONE. 5 screens (Home/Trade/Decision/Your
   Scars/Settings), centered 72rem layout, tonal bands, mobile stacking,
   per-screen wallet displays, EIP-6963 picker, real-data home stats,
   loading/empty/error states. Fixed `renderDecision` undefined-amount
   crash and all stale single-screen element refs. Removed `web3` stub dep.
2. Decision flow — DONE and live-tested (ALLOW/DENY/SAFER_TERMS with real
   quotes). `/swap` re-evaluates server-side on live conditions: non-ALLOW
   => 403 zero calldata (no frontend bypass). Safer suggestions computed
   in engine; "Try safer" re-runs fresh quote->Sibyl->evaluation.
   Fixed receipt-status encoding bug (accepts 1/'0x1'/'0x01'/true).
3. Wallet execution — PARTIAL. Calldata verified byte-identical to a real
   mined swap; approval selector verified; chain config consistent;
   response shape matches frontend; approval/receipt/error/explorer flows
   code-verified. BLOCKED: live signing needs a funded Base Sepolia
   wallet (no key available in this environment).
4. Learning loop + fresh session — DONE. Session A ALLOW->FAILED stored;
   server restarted; Session B same wallet/similar trade DENY citing the
   prior txHash; /swap bypass 403; isolation holds; GOOD journal-only.
5. Virtuals ACP — REAL WIRING, live job BLOCKED. SDK researched
   (virtuals-acp 0.3.23, ACP v2, BASE_SEPOLIA_CONFIG_V2). Live discovery
   proven (HTTP 200, real agents). `src/specialist.py` implements the
   genuine buyer flow (browse->initiate->poll COMPLETED->parse memo),
   config-gated with explicit unavailable codes, advisory only.
   BLOCKED: live job needs registered-agent credentials
   (VIRTUALS_AGENT_WALLET_ADDRESS, VIRTUALS_WALLET_PRIVATE_KEY,
   VIRTUALS_ENTITY_ID) + fare funding; no suitable fee-based risk
   offering found in discovery either.
6. Polish — DONE. Hierarchy, spacing, mobile, states, copy style.
7. Cleanup — DONE. Dead code/ABI dicts/unused helpers removed, single
   chain-truth module, relative sys.path, .gitignore, pycache untracked.
8. Documentation — DONE (this pass). Final audit: see handoff.md.

Not built: on-chain history reader (history = meaningful Sibyl
experiences by design), Uniswap Trading API fallback (direct QuoterV2
only), production build step (none needed: static + FastAPI).
