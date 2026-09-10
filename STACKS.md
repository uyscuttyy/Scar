# SCAR stacks — everything the app stands on, and why

No framework soup. Every dependency below earns its place. If you are a
host wondering "can I run and trust this?" — start here. Short answer:
yes, on any machine with Python 3.10+: two commands and you are live.

```bash
pip install -r requirements.txt
SCAR_DB=/tmp/scar_memory.db .venv/bin/python -m uvicorn src.app:app --host 127.0.0.1 --port 8000
```

---

## Backend: Python + FastAPI + Uvicorn

- **Python 3.10+** — the whole backend is plain Python, no exotic version needed.
- **FastAPI** — the API layer (`src/app.py`). It serves the JSON endpoints
  (`/quote`, `/evaluate`, `/swap`, `/record`, `/history`, `/consult`) and
  also serves the frontend as static files, so there is exactly one thing to
  run. Request/response validation comes free via Pydantic models, which
  means malformed trade requests get rejected before they touch any logic.
- **Uvicorn** — the server that runs FastAPI. One command, no reverse proxy
  needed for local runs or demos.

Why this combo: you can read every line, the startup time is seconds, and
the server-side decision gate (re-evaluating inside `/swap` and returning
403 + zero calldata on DENY) lives in the same process as the API — no
network hop a frontend could skip.

## Memory: Sibyl (`sibyl-memory-client==0.8.1`)

- Scar's long-term memory. Each wallet address is its own tenant, so
  memories are isolated per user with zero extra code.
- The engine only uses three operations: store an experience, list a
  wallet's experiences, and (rarely) mark one superseded or pruned.
- Fail-closed by contract: if Sibyl errors, `/evaluate` answers 503 and
  `/swap` refuses — Scar never invents a decision without memory.

Full detail lives in [MEMORY_IMPLEMENTATION.md](./MEMORY_IMPLEMENTATION.md).

## On-chain: Base Sepolia + Uniswap v3

- **Base Sepolia (chain ID 84532)** — the execution network. Cheap testnet
  gas, public explorer (sepolia.basescan.org) so every trade is verifiable.
- **Uniswap v3** — the swap layer. Real `QuoterV2` quotes (expected output,
  fees, price impact) and real `SwapRouter02.exactInputSingle` calldata at
  the 0.3% fee tier. The app never invents a price.
- **RPC**: `https://sepolia.base.org` (overridable with `BASE_SEPOLIA_RPC`).
  Quotes, receipts, and balances all come from here.

## Crypto plumbing (no web3 dependency)

Instead of the heavy `web3` package, Scar uses four small exact tools:

- **eth-abi** — encodes the QuoterV2 and SwapRouter02 struct calldata
  (byte-identical to real mined swaps, verified).
- **eth-utils** — keccak selectors, checksums, unit conversions.
- **eth-keys** — only used by the offline E2E scripts, never in the server.
- **httpx** — JSON-RPC calls to Base Sepolia and the ACP gateway.

Less surface area, fewer surprises, faster installs.

## Specialist advice: Virtuals ACP (`virtuals-acp==0.3.23`)

- Gives Scar a hotline to specialist agents on Base Sepolia when its own
  memory is too thin to decide.
- Strictly advisory: the assessment refines a suggestion, it never
  authorizes a trade. Unconfigured or unreachable = an honest
  "unavailable", never a faked opinion.
- Live agent discovery runs against the production ACP gateway; spinning up
  an actual paid job needs registered-agent credentials
  (`VIRTUALS_AGENT_WALLET_ADDRESS`, `VIRTUALS_WALLET_PRIVATE_KEY`,
  `VIRTUALS_ENTITY_ID`), which is why demos show discovery, not jobs.

## Frontend: no framework at all

- Plain **HTML + CSS + vanilla JS**, four pages sharing one stylesheet and
  one script. No build step, no bundler, no node_modules — the backend
  serves the files as-is, so what you edit is what you see after reload.
- **Fonts**: Figtree (UI), Merriweather (editorial headlines), Space Grotesk
  (headers, numbers, futuristic touches) via Google Fonts.
- **Wallet**: raw EIP-1193 + EIP-6963 discovery in ~150 lines of JS. No
  wagmi/viem rainbow-kit stack, because the multi-extension conflict
  (MetaMask + Phantom + selector plugins fighting over `window.ethereum`)
  is handled explicitly: per-provider connections with ordered fallback.

## Data: SQLite via Sibyl's local client

- `SCAR_DB` points at a SQLite file (default `/tmp/scar_memory.db` in our
  run commands — point it somewhere permanent for real use). Memories
  survive restarts because they live in this file, not in server RAM.
- No migrations, no separate database process.

## Dev/test helpers

- **scripts/demo.py** — scripted ALLOW → FAIL → DENY loop against a live server.
- **e2e_swap.py / e2e_fail.py** — real signed end-to-end runs (need a funded key).
- **tests/test_virtuals_acp.py** — proves the ACP integration is real
  (SDK, chain config, live discovery, honest-unavailable, no invented memos).
- **tests/test_engine.py** — decision-engine unit checks (needs `pytest`).

## Environment variables

| Variable | What it does | Required? |
|----------|--------------|-----------|
| `SCAR_DB` | SQLite file for memory | No (has default) |
| `BASE_SEPOLIA_RPC` | Override the RPC endpoint | No |
| `VIRTUALS_AGENT_WALLET_ADDRESS` | Registered agent wallet | Only for live ACP jobs |
| `VIRTUALS_WALLET_PRIVATE_KEY` | Agent signer key | Only for live ACP jobs |
| `VIRTUALS_ENTITY_ID` | Agent entity ID | Only for live ACP jobs |
| `VIRTUALS_SPECIALIST_KEYWORD` | Which specialist to prefer | No |
| `VIRTUALS_MAX_FARE_USDC` | Job fare cap | No |
| `VIRTUALS_CONSULT_TIMEOUT_S` | Consult timeout | No |
| `SCAR_API` | Base URL for scripts/tests | No (defaults to localhost:8000) |
