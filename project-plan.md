# SCAR project plan (actual)

1. Repository audit — DONE. Found 6 files, no package.json/git/tests,
   missing deps, /health shadowed by static mount.
2. Dependency repair — DONE. `.venv` via uv, sibyl-memory-client==0.8.1,
   fastapi, uvicorn installed and verified.
3. Local startup — DONE. `SCAR_DB=... .venv/bin/python -m uvicorn
   src.app:app --port 8000`. Fixed mount order. /health 200.
4. UI verification — PARTIAL. Static page serves (1559b, no JS).
   Browser tool daemon down; no console errors possible (no JS).
   Full 4-screen UI not built.
5. Sibyl research — DONE. Python-only SDK, tenant isolation, free-tier
   primitives; learn/lint gated and unused. Docs recorded.
6. Wallet + Base Sepolia — PARTIAL. Tenant scoping live; contract refs
   verified; no wallet-connect UI yet.
7. On-chain history — NOT BUILT. No explorer/RPC reader yet.
8. Decision engine — DONE and live-tested (DENY/ALLOW/SAFER_TERMS).
9. Uniswap quote/execution — PARTIAL. Refs only; no live quote or tx.
10. Memory capture/ranking/pruning — DONE and live-tested.
11. Fresh-session persistence — DONE. DENY survives server restart.
12. Wallet isolation — DONE. 0xtest2 unaffected by 0xtest1's BAD memory.
13. Failure-mode testing — DONE. Broken store -> SIBYL_UNAVAILABLE DENY.
14. E2E verification — DONE for memory loop; swap-execution loop pending UI.
15. Final hostile audit — see handoff.md.
