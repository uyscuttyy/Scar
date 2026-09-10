from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pathlib import Path
import os, sys, time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import build_situation, evaluate, record_experience
from specialist import consult as specialist_consult, status as specialist_status
from sibyl_memory_client import MemoryClient
from uniswap import (get_best_quote, get_spot_rate, encode_swap_call,
                     encode_erc20_approve, encode_permit2_approve,
                     USDC, WETH, CHAIN_ID, PERMIT2, SWAP_ROUTER_02,
                     QUOTER_V2, UNIVERSAL_ROUTER)

app = FastAPI()

DB_PATH = os.environ.get("SCAR_DB", "/tmp/scar_memory.db")

class Record(BaseModel):
    wallet: str
    pair: str = ""
    direction: str = ""
    amount: float = 0
    slippageBps: int = 0
    impactBps: int = 0
    outcome: str = ""
    reason: str = ""
    txHash: str = ""

class QuoteRequest(BaseModel):
    wallet: str
    fromToken: str
    toToken: str
    amount: float
    amountDecimals: int = 18

class SwapRequest(BaseModel):
    wallet: str
    fromToken: str
    toToken: str
    amount: float
    amountDecimals: int = 18
    slippageBps: int = 200
    quote: dict = {}
    pair: str = ""
    direction: str = "sell"


def _pair_for(from_token: str, to_token: str) -> str:
    def sym(a: str) -> str:
        a = (a or "").lower()
        if a == USDC.lower():
            return "USDC"
        if a == WETH.lower():
            return "WETH"
        return (a[:6] + "…" + a[-4:]) if a else "?"
    return f"{sym(from_token)}-{sym(to_token)}"

class EvaluateRequest(BaseModel):
    wallet: str
    pair: str
    direction: str
    amount: float = 50.0
    slippage_bps: int = 200
    impact_bps: int = 0

@app.get("/health")
def health():
    try:
        c = MemoryClient.local(DB_PATH)
        c.list_entities(category="scar_swap", limit=1)
        return {"sibyl": "available", "db": DB_PATH}
    except Exception as e:
        return {"sibyl": "unavailable", "db": DB_PATH, "status": "FAIL_CLOSED", "error": str(e)}

@app.get("/quote_ref")
def quote_ref():
    return {
        "quoter_v2": QUOTER_V2,
        "router": SWAP_ROUTER_02,
        "universal_router": UNIVERSAL_ROUTER,
        "usdc": USDC,
        "weth": WETH,
        "chain_id": CHAIN_ID,
        "note": "Real QuoterV2 eth_call -> real quote; no fabricated values."
    }

@app.post("/quote")
async def get_quote(req: QuoteRequest):
    """Get real quote from Uniswap v3 QuoterV2 on Base Sepolia via eth_call."""
    try:
        # Convert amount to wei
        amount_wei = int(req.amount * (10 ** req.amountDecimals))

        # Real quote: best live-pool fee tier via QuoterV2 eth_call.
        quote_data = await get_best_quote(req.fromToken, req.toToken, amount_wei)

        amount_out = quote_data["amountOut"]
        gas_estimate = quote_data["gasEstimate"]
        fee = quote_data["fee"]

        # Determine output token decimals
        to_decimals = 6 if req.toToken.lower() == USDC.lower() else 18
        from_decimals = 6 if req.fromToken.lower() == USDC.lower() else 18

        # Expected rate (output per input)
        expected_rate = amount_out / amount_wei * (10 ** from_decimals) / (10 ** to_decimals) if amount_wei > 0 else 0

        # Min output with slippage tolerance (0.5% default)
        slippage_tolerance = 0.005
        min_output = int(amount_out * (1 - slippage_tolerance))
        slippage_bps = int(slippage_tolerance * 10000)

        # Real price impact: quoted rate vs pool spot rate (slot0).
        # If spot is unreadable, omit impact (None) — never fabricate.
        price_impact_bps = None
        try:
            spot = await get_spot_rate(req.fromToken, req.toToken,
                                       req.amountDecimals, to_decimals, fee)
            if spot and spot > 0 and expected_rate > 0:
                price_impact_bps = int(abs(expected_rate - spot) / spot * 10000)
        except Exception:
            price_impact_bps = None

        return {
            "fromToken": req.fromToken,
            "toToken": req.toToken,
            "amount": req.amount,
            "expectedOutput": amount_out,
            "expectedRate": expected_rate,
            "minOutput": min_output,
            "slippageBps": slippage_bps,
            "priceImpactBps": price_impact_bps,
            "gasEstimate": gas_estimate,
            "fee": fee,
            "quoteId": f"quoter_{int(time.time())}"
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Quote failed: {str(e)}")

@app.post("/evaluate")
def evaluate_post(req: EvaluateRequest):
    try:
        c = MemoryClient.local(DB_PATH, tenant_id=req.wallet.lower())
    except Exception as e:
        raise HTTPException(status_code=503, detail={"decision": "DENY", "code": "SIBYL_UNAVAILABLE", "message": "Sibyl unavailable — no swap.", "tx_submitted": False, "error": str(e)})

    result = evaluate(c, build_situation(req.wallet, req.pair, req.direction, req.amount, req.slippage_bps, req.impact_bps))
    return {**result, "wallet_scoped": req.wallet.lower()}

@app.post("/record")
def record(r: Record):
    try:
        c = MemoryClient.local(DB_PATH, tenant_id=r.wallet.lower())
    except Exception as e:
        raise HTTPException(status_code=503, detail={"stored": False, "fail_closed": True, "error": str(e)})
    return record_experience(c, r.wallet, r.model_dump())

@app.post("/swap")
async def prepare_swap(req: SwapRequest):
    """Prepare swap transaction calldata for SwapRouter02.

    Decision-gated: Scar re-evaluates the live situation (Sibyl read)
    before building ANY calldata. Non-ALLOW yields 403 with the
    decision and zero transaction data, so no frontend bypass can
    submit a denied trade."""
    try:
        c = MemoryClient.local(DB_PATH, tenant_id=req.wallet.lower())
    except Exception as e:
        raise HTTPException(status_code=503, detail={"decision": "DENY", "code": "SIBYL_UNAVAILABLE", "message": "Sibyl unavailable — no swap.", "tx_submitted": False, "error": str(e)})
    pair = req.pair or _pair_for(req.fromToken, req.toToken)
    try:
        amount_wei = int(req.amount * (10 ** req.amountDecimals))

        # Fresh live quote first, so the gate below sees live conditions
        # instead of trusting client-supplied numbers.
        quote_data = await get_best_quote(req.fromToken, req.toToken, amount_wei)
        fee = quote_data["fee"]
        amount_out = quote_data["amountOut"]

        # Live price impact: quoted rate vs pool slot0 spot (same as /quote).
        # Unreadable spot => impact omitted (0 signal), never fabricated.
        to_decimals = 6 if req.toToken.lower() == USDC.lower() else 18
        from_decimals = 6 if req.fromToken.lower() == USDC.lower() else 18
        live_impact = 0
        try:
            expected_rate = amount_out / amount_wei * (10 ** from_decimals) / (10 ** to_decimals) if amount_wei > 0 else 0
            spot = await get_spot_rate(req.fromToken, req.toToken,
                                       req.amountDecimals, to_decimals, fee)
            if spot and spot > 0 and expected_rate > 0:
                live_impact = int(abs(expected_rate - spot) / spot * 10000)
        except Exception:
            live_impact = 0

        gate = evaluate(c, build_situation(req.wallet, pair, req.direction or "sell",
                                           req.amount, req.slippageBps, live_impact))
        if gate.get("decision") != "ALLOW":
            raise HTTPException(status_code=403, detail={**gate, "wallet_scoped": req.wallet.lower()})

        amount_out_min = int(amount_out * (1 - req.slippageBps / 10000))

        # Encode swap call
        swap_data = encode_swap_call(
            req.fromToken, req.toToken, fee, req.wallet,
            amount_wei, amount_out_min
        )

        # ERC20 approval to the router itself. Traced on-chain: this
        # SwapRouter02 pulls input via direct transferFrom with the
        # router as spender, so wallet->router allowance is REQUIRED.
        # (Permit2 approval is also returned for routers that use it.)
        approval_data = encode_erc20_approve(req.fromToken, SWAP_ROUTER_02,
                                             amount_wei)
        permit2_data = encode_permit2_approve(req.fromToken, SWAP_ROUTER_02, amount_wei)

        return {
            "to": SWAP_ROUTER_02,
            "data": swap_data,
            "value": "0x0",
            "gasEstimate": hex(quote_data["gasEstimate"] + 50000),  # Add buffer
            "approval": {
                "to": req.fromToken,
                "data": approval_data,
                "value": "0x0",
                "spender": SWAP_ROUTER_02,
            },
            "permit2": {
                "to": PERMIT2,
                "data": permit2_data,
                "value": "0x0"
            },
            "quoteId": f"swap_{int(time.time())}"
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Swap preparation failed: {str(e)}")

class ConsultRequest(BaseModel):
    wallet: str
    pair: str
    direction: str = "sell"
    amount: float = 0
    slippage_bps: int = 0
    impact_bps: int = 0
    context: str = ""


@app.get("/specialist/status")
def get_specialist_status():
    return specialist_status()


@app.post("/consult")
def consult_specialist(req: ConsultRequest):
    """Ask a Virtuals ACP specialist for a risk assessment (sync, bounded).

    Advisory only: the returned assessment never authorizes a trade by
    itself. Unconfigured/failing specialist => explicit unavailable, and
    Scar's deterministic decision stands."""
    sit = build_situation(req.wallet, req.pair, req.direction,
                          req.amount, req.slippage_bps, req.impact_bps)
    return specialist_consult(sit, req.context)


@app.get("/history")
def get_history(wallet: str):
    try:
        c = MemoryClient.local(DB_PATH, tenant_id=wallet.lower())
        rows = c.list_entities(category="scar_swap", limit=100)
        return {"memories": rows}
    except Exception as e:
        raise HTTPException(status_code=503, detail={"error": str(e)})

# Static files - mount LAST so API routes take priority
from pathlib import Path
from fastapi.staticfiles import StaticFiles
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")