# Real Uniswap v3 QuoterV2 integration for Base Sepolia
# Uses eth_call to QuoterV2 contract directly - no API key needed

from eth_abi import encode
from eth_utils import keccak, to_checksum_address
import httpx
import os

# Base Sepolia RPC
RPC_URL = os.environ.get("BASE_SEPOLIA_RPC", "https://sepolia.base.org")

# Contract addresses (verified from Uniswap docs + Circle docs)
QUOTER_V2 = "0xC5290058841028F1614F3A6F0F5816cAd0df5E27"
SWAP_ROUTER_02 = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4"
UNIVERSAL_ROUTER = "0x492E6456D9528771018DeB9E87ef7750EF184104"
PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
WETH = "0x4200000000000000000000000000000000000006"
CHAIN_ID = 84532

# QuoterV2 (v3-periphery >=1.3) takes a STRUCT, not 5 flat args:
# QuoteExactInputSingleParams { tokenIn, tokenOut, amountIn, fee,
#   sqrtPriceLimitX96 } — note amountIn comes BEFORE fee.
# The flat-arg encoding reverts on-chain; verified live on Base Sepolia.
QUOTE_SINGLE_SIG = "quoteExactInputSingle((address,address,uint256,uint24,uint160))"

# Fee tiers to try for a pair, in order of preference. Canonical
# USDC-WETH tier is 500. get_best_quote checks pool existence per tier
# via the factory and returns the best amountOut.
FEE_TIERS = (500, 3000, 10000, 100)

FACTORY = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"

async def get_pool_address(token_in: str, token_out: str, fee: int) -> str | None:
    """Factory pool address for a tier, or None if no pool exists."""
    selector = keccak(text="getPool(address,address,uint24)")[:4]
    encoded = encode(
        ["address", "address", "uint24"],
        [to_checksum_address(token_in), to_checksum_address(token_out), fee]
    )
    result = await rpc_call("eth_call", [
        {"to": FACTORY, "data": "0x" + selector.hex() + encoded.hex()},
        "latest"])
    if isinstance(result, dict) and "error" in result:
        return None
    raw = result.get("result", "0x") if isinstance(result, dict) else "0x"
    if raw.lower() == "0x" + "00" * 32 or int(raw, 16) == 0:
        return None
    return "0x" + raw[-40:]


async def get_spot_rate(token_in: str, token_out: str, dec_in: int,
                        dec_out: int, fee: int) -> float | None:
    """Pool spot rate (tokenOut per tokenIn) from slot0 sqrtPriceX96.

    Returns None if the pool is missing or unreadable — the caller must
    omit impact rather than fabricate it."""
    from eth_abi import decode as abi_decode
    pool = await get_pool_address(token_in, token_out, fee)
    if pool is None:
        return None
    try:
        selector = keccak(text="slot0()")[:4]
        result = await rpc_call("eth_call",
                                [{"to": pool, "data": "0x" + selector.hex()},
                                 "latest"])
        if isinstance(result, dict) and "error" in result:
            return None
        raw = result.get("result", "0x") if isinstance(result, dict) else "0x"
        data = bytes.fromhex(raw[2:])
        if len(data) < 32:
            return None
        sqrt_px96 = abi_decode(["uint160"], data[:32])[0]
        if sqrt_px96 == 0:
            return None
        # token0 < token1 by address. Human-unit price of token1 per
        # token0, using this pair's actual decimals.
        t0, t1 = sorted([token_in.lower(), token_out.lower()])
        dec0 = dec_in if token_in.lower() == t0 else dec_out
        dec1 = dec_out if token_in.lower() == t0 else dec_in
        price1_per_0 = (sqrt_px96 / 2**96) ** 2 * 10 ** (dec0 - dec1)
        if price1_per_0 <= 0:
            return None
        if token_in.lower() == t0:
            return price1_per_0  # tokenOut is token1
        return 1.0 / price1_per_0  # tokenOut is token0
    except Exception:
        return None

async def rpc_call(method: str, params: list) -> dict:
    """Make a JSON-RPC call to Base Sepolia."""
    async with httpx.AsyncClient(timeout=15.0,
                                 headers={"User-Agent": "scar/1.0"}) as client:
        resp = await client.post(RPC_URL, json={
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": 1
        })
    return resp.json()

async def eth_call(to: str, data: str) -> str:
    """Execute eth_call and return result."""
    result = await rpc_call("eth_call", [{"to": to, "data": data}, "latest"])
    if "error" in result:
        raise Exception(f"RPC error: {result['error']}")
    return result.get("result", "0x")

def encode_quote_call(token_in: str, token_out: str, amount_in: int, fee: int) -> str:
    """Encode quoteExactInputSingle struct call data."""
    # Struct field order: tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96.
    selector = keccak(text=QUOTE_SINGLE_SIG)[:4]
    encoded = encode(
        ["(address,address,uint256,uint24,uint160)"],
        [[to_checksum_address(token_in), to_checksum_address(token_out),
          amount_in, fee, 0]]
    )
    return "0x" + selector.hex() + encoded.hex()

def decode_quote_result(result: str) -> dict:
    """Decode quoteExactInputSingle result."""
    # Remove 0x prefix
    data = bytes.fromhex(result[2:]) if result.startswith("0x") else bytes.fromhex(result)
    # Decode: amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate
    from eth_abi import decode as abi_decode
    amount_out, sqrt_price_after, ticks_crossed, gas_estimate = abi_decode(
        ["uint256", "uint160", "uint32", "uint256"],
        data
    )
    return {
        "amountOut": amount_out,
        "sqrtPriceX96After": sqrt_price_after,
        "initializedTicksCrossed": ticks_crossed,
        "gasEstimate": gas_estimate
    }

async def get_best_quote(token_in: str, token_out: str,
                         amount_in: int) -> dict:
    """Quote every fee tier with a live pool; return the best amountOut.

    Same pair, same Uniswap v3 deployment — tier routing only, no
    multi-DEX aggregation. Raises if no tier returns a quote."""
    best: dict | None = None
    errors: list[str] = []
    for fee in FEE_TIERS:
        try:
            if await get_pool_address(token_in, token_out, fee) is None:
                continue
            call_data = encode_quote_call(token_in, token_out, amount_in, fee)
            decoded = decode_quote_result(await eth_call(QUOTER_V2, call_data))
            quote = {
                "amountOut": decoded["amountOut"],
                "gasEstimate": decoded["gasEstimate"],
                "fee": fee,
                "tokenIn": token_in,
                "tokenOut": token_out,
                "amountIn": amount_in,
            }
            if best is None or quote["amountOut"] > best["amountOut"]:
                best = quote
        except Exception as e:
            errors.append(f"fee={fee}: {e}")
    if best is None:
        raise Exception("No live pool quote: " + "; ".join(errors))
    return best

# SwapRouter02 exactInputSingle takes a struct:
# ExactInputSingleParams { tokenIn, tokenOut, fee, recipient, amountIn,
#   amountOutMinimum, sqrtPriceLimitX96 }.

def encode_swap_call(token_in: str, token_out: str, fee: int, recipient: str,
                     amount_in: int, amount_out_min: int) -> str:
    """Encode exactInputSingle call data for SwapRouter02."""
    selector = keccak(text="exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")[:4]
    encoded = encode(
        ["(address,address,uint24,address,uint256,uint256,uint160)"],
        [[to_checksum_address(token_in), to_checksum_address(token_out), fee,
          to_checksum_address(recipient), amount_in, amount_out_min, 0]]
    )
    return "0x" + selector.hex() + encoded.hex()

# Permit2 approve(token, spender, amount, expiration).

def encode_permit2_approve(token: str, spender: str, amount: int, expiration: int = 2**48 - 1) -> str:
    """Encode Permit2 approve call data."""
    selector = keccak(text="approve(address,address,uint160,uint48)")[:4]
    encoded = encode(
        ["address", "address", "uint160", "uint48"],
        [to_checksum_address(token), to_checksum_address(spender), amount, expiration]
    )
    return "0x" + selector.hex() + encoded.hex()


def encode_erc20_approve(token: str, spender: str, amount: int) -> str:
    """Encode plain ERC20 approve(spender, amount) call data.

    Required because the Base Sepolia SwapRouter02 pulls input tokens
    via direct transferFrom (traced on-chain: router is the spender),
    not only via Permit2."""
    selector = keccak(text="approve(address,uint256)")[:4]
    encoded = encode(
        ["address", "uint256"],
        [to_checksum_address(spender), amount]
    )
    return "0x" + selector.hex() + encoded.hex()