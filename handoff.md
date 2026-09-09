# SCAR handoff (current state)

## What Scar is now
A 5-screen memory-aware swap agent on Base Sepolia: Home, Trade, SCAR
Decision, Your Scars, Settings. Real Uniswap v3 quotes, deterministic
memory-gated decisions, wallet-signed execution, automatic post-trade
learning to wallet-scoped Sibyl memory, plus config-gated Virtuals ACP
specialist consultation (advisory only).

## What actually works (executed, not claimed)
- Live QuoterV2 quotes + measured price impact (POST /quote, verified).
- ALLOW/DENY/SAFER_TERMS with real conditions; DENY cites blocking memory.
- `/swap` server-side decision gate: bypass POST returns 403, zero calldata.
- Safer suggestions computed from bucket logic; re-evaluation reaches ALLOW.
- Fresh-session proof: ALLOW->FAILED stored -> restart -> DENY citing
  prior txHash; isolation holds; GOOD journal-only (importance 25).
- Supersede fixed: easy GOOD no longer retires harsh FAILED (verified
  both directions).
- Fail-closed: broken store -> DENY SIBYL_UNAVAILABLE, zero tx (verified).
- Calldata byte-identical to a real mined swap (0x04e45aaf path).
- ACP discovery live (HTTP 200); /consult returns explicit unavailable
  without credentials; no faked assessments anywhere.
- /health, /quote_ref, /history, /specialist/status return 200.

## Blockers / not done
- Live wallet signing: needs a funded Base Sepolia wallet. Everything up
  to the signature is verified; the signature-to-receipt leg is not.
- Live ACP job: needs registered-agent credentials
  (VIRTUALS_AGENT_WALLET_ADDRESS, VIRTUALS_WALLET_PRIVATE_KEY,
  VIRTUALS_ENTITY_ID) plus fare funding. Discovery and the full buyer
  code path are real; no job has been executed.
- Browser-console check: harness daemon was down, so UI runtime is
  statically verified (node --check, ID cross-check, served 200s), not
  live-clicked.
- No automated test suite, linter, or CI (documented, not built).

## Run
SCAR_DB=/tmp/scar_memory.db .venv/bin/python -m uvicorn src.app:app \
  --host 127.0.0.1 --port 8000
Requires: .venv with requirements.txt (uv pip install -r requirements.txt;
note charset-normalizer==3.4.1 / frozenlist==1.7.0 pins work around bad
cp314 wheels). No frontend build step.

## Env (optional)
VIRTUALS_AGENT_WALLET_ADDRESS, VIRTUALS_WALLET_PRIVATE_KEY,
VIRTUALS_ENTITY_ID, VIRTUALS_SPECIALIST_KEYWORD,
VIRTUALS_PROVIDER_ADDRESS, VIRTUALS_MAX_FARE_USDC,
VIRTUALS_CONSULT_TIMEOUT_S, BASE_SEPOLIA_RPC, SCAR_DB.

## Do not trust without re-running
Re-run the Phase 2/4 curl sequences (ALLOW, record BAD, DENY, bypass
403, restart, DENY-cites-memory) before any demo. For the demo you need
a funded Base Sepolia wallet in the browser.
