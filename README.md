# SCAR — your trading agent that remembers

Scar is simple: it remembers your bad trades so you don't repeat them.

You tell Scar you want to swap (say USDC → WETH). Before anything moves
on-chain, Scar digs up your past experiences with similar trades, compares
the current conditions (slippage, price impact) with what burned you before,
and gives one of three answers:

- **ALLOW** — looks fine, go ahead and sign.
- **DENY** — this looks like a past mistake. Zero transactions submitted.
- **SAFER TERMS** — risky, but here is a smaller size that could work.

After the trade, Scar scores the experience. Boring routine wins get
journaled and forgotten. Painful ones become **scars** that change future
decisions. Memories are scoped to your wallet, survive restarts, and if the
memory service ever goes down, Scar blocks trades instead of guessing.

No sign-up. No tokens. No chatbot. Just memory.

---

## What you need

1. **Python 3.10+** and a browser with a wallet (MetaMask works best).
2. **Base Sepolia testnet** in your wallet (Chain ID 84532). Scar will offer
   to switch you automatically.
3. A little **Sepolia ETH** (gas) and **USDC on Base Sepolia**
   (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) if you want to actually swap.
   No funds needed to click around, read decisions, or view scars.

> Got MetaMask + Phantom + other extensions installed at once? They fight
> over the connection. If connecting acts weird, the trade page tries each
> wallet in turn — just hit Connect Wallet and approve in the right one.

---

## Setup (first time)

```bash
cd /home/uyscutty/projects/scar

# 1. Make a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install everything
pip install -r requirements.txt
```

That's it. No build step, no frontend compiling — the UI is plain HTML/CSS/JS
served straight by the backend.

---

## Run it

```bash
source .venv/bin/activate
SCAR_DB=/tmp/scar_memory.db .venv/bin/python -m uvicorn src.app:app --host 127.0.0.1 --port 8000
```

Then open **http://127.0.0.1:8000** in your browser.

| Page | What it's for |
|------|---------------|
| `/index.html` | The landing page — what Scar is, live demo card, how memory changes decisions |
| `/trade.html` | The actual app — connect, quote, review, sign, learn |
| `/scars.html` | Your scars — every important experience tied to your wallet |
| `/how.html` | The full breakdown — steps, condition-aware memory, specialist help, the loop |

Health check: `curl http://127.0.0.1:8000/health` should say sibyl is available.

---

## Take it for a spin (the full loop)

1. Go to the **trade page**, hit **Connect Wallet**, approve in your wallet.
2. Type an amount (try 0.5 USDC → WETH) and press **Review swap**.
3. Scar quotes via Uniswap, checks your memory, and shows ALLOW, DENY, or SAFER TERMS.
4. If ALLOW, press **Confirm swap**, sign in your wallet, wait for the receipt.
5. Look under the receipt: a lilac note tells you whether Scar kept it as a
   scar or journaled it as routine.
6. Now make a **similar trade under similar (or worse) conditions** — Scar
   should DENY it and name the memory that blocked it.
7. Check the **scars page**: painful experiences show up as cards with the
   pair, conditions, outcome, and why Scar remembers them.

Routine wins won't appear as scars — that's on purpose. Scar only keeps
what is important enough to change a decision (importance 30+).

---

## How the pieces fit

```
you → trade page → /quote (Uniswap, Base Sepolia)
                → /evaluate (build situation → Sibyl memories → decide)
                → ALLOW? sign in wallet → receipt → /record (score + store)
```

- **Sibyl** (`sibyl-memory-client`) is the memory. Wallet address = tenant,
  so memories never leak across wallets. No memory = no experience-aware
  decision, and failures block trades instead of allowing them.
- **Uniswap v3** on Base Sepolia is the swap layer (real QuoterV2 quotes,
  real `exactInputSingle` calldata, 0.3% fee tier).
- **Virtuals ACP** is the specialist hotline: when Scar is uncertain with no
  memory to ground it, it can ask another agent for analysis. Advisory only —
  Scar always makes the final call.
- **Decision engine** (`src/engine.py`) is deterministic — no LLM, no vibes.
  Same situation + same memories = same decision, every time.

API cheat sheet: `GET /health`, `POST /quote`, `POST /evaluate`,
`POST /swap` (re-checks the decision server-side, 403 + zero calldata on
DENY), `POST /record`, `GET /history?wallet=0x...`,
`GET /specialist/status`, `POST /consult`.

---

## Project layout

```
static/            the whole frontend (index/trade/scars/how + css + js)
src/
  app.py           API routes + decision gate + static serving
  engine.py        situation building, decisions, importance scoring
  uniswap.py       QuoterV2 + SwapRouter02 encoding
  specialist.py    Virtuals ACP wrapper (honest when unconfigured)
tests/             ACP verification checks
scripts/demo.py    scripted ALLOW → FAIL → DENY demo flow
e2e_swap.py / e2e_fail.py   live end-to-end scripts (need a funded key)
```

---

## Troubleshooting

- **Connect does nothing** — open dev tools (F12), look for lines starting
  with `[scar]`. `4001` = you rejected it, approve next time. `-32002` = a
  popup is already waiting inside your extension, open it. Nothing at all =
  no extension found, install MetaMask and reload.
- **Review stays disabled** — you're either disconnected, on the wrong
  network (switch to Base Sepolia in your wallet), or the amount exceeds
  your balance.
- **Trade succeeded but scars page is empty** — normal for a routine win
  (see "Take it for a spin" step 5). Scars are for painful stuff.
- **Sibyl errors** — trades get denied with the reason shown. Memory failing
  closed is a feature, not a bug.
- **Port already in use** — kill the old server: `pkill -f "uvicorn src.app:app"`.

---

## One more thing

Scar runs on testnet with play money. The decisions are real logic, the
swaps are real transactions, the memories are really yours — but nothing
here is financial advice. Don't YOLO your rent.
