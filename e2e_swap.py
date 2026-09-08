"""SCAR E2E: real quote -> real decision -> signed swap -> receipt -> memory."""
import json, sys, time
import httpx
from eth_abi import encode
from eth_utils import keccak, to_checksum_address
from eth_keys import keys

RPC = "https://sepolia.base.org"
API = "http://127.0.0.1:8000"
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
WETH = "0x4200000000000000000000000000000000000006"
PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
CHAIN = 84532
H = {"User-Agent": "scar/1.0", "Content-Type": "application/json"}
AMOUNT_USDC = 1.0
AMOUNT_WEI = int(AMOUNT_USDC * 10**6)

pk = keys.PrivateKey(bytes.fromhex(open("/tmp/scar_testkey").read().strip().removeprefix("0x")))
WALLET = pk.public_key.to_checksum_address()
print("wallet:", WALLET)

def rpc(method, params):
    r = httpx.post(RPC, json={"jsonrpc": "2.0", "method": method,
                              "params": params, "id": 1},
                   headers=H, timeout=20.0)
    j = r.json()
    if "error" in j:
        raise Exception(f"RPC {method}: {j['error']}")
    return j["result"]

def api(method, path, body=None):
    if method == "GET":
        r = httpx.get(API + path, timeout=30.0)
    else:
        r = httpx.post(API + path, json=body, timeout=60.0)
    r.raise_for_status()
    return r.json()

# --- minimal RLP ---
def rlp_encode(item):
    def encode_length(n, offset):
        if n <= 55:
            return bytes([offset + n])
        bl = n.to_bytes((n.bit_length() + 7) // 8, "big")
        return bytes([offset + 55 + len(bl)]) + bl
    if isinstance(item, list):
        payload = b"".join(rlp_encode(x) for x in item)
        return encode_length(len(payload), 0xc0) + payload
    b = item if isinstance(item, bytes) else bytes(item)
    if len(b) == 1 and b[0] < 0x80:
        return b
    return encode_length(len(b), 0x80) + b

def to_bytes(v):
    if isinstance(v, bytes):
        return v
    if isinstance(v, str) and v.startswith("0x"):
        v = v[3:]
        return bytes.fromhex(v) if v else b""
    if isinstance(v, int):
        return b"" if v == 0 else v.to_bytes((v.bit_length() + 7) // 8, "big")
    raise TypeError(v)

_nonce = None
def send_tx(to_addr, data_hex, gas_limit, value=0):
    global _nonce
    if _nonce is None:
        _nonce = int(rpc("eth_getTransactionCount", [WALLET, "pending"]), 16)
    nonce = _nonce
    _nonce += 1
    base = int(rpc("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
    prio, maxfee = 1_000_000, base * 2 + 1_000_000
    unsigned = [CHAIN, nonce, prio, maxfee, gas_limit,
                bytes.fromhex(to_addr[2:]), value,
                bytes.fromhex(data_hex[2:] if data_hex.startswith("0x") else data_hex), []]
    sighash = keccak(b"\x02" + rlp_encode([to_bytes(x) if not isinstance(x, list) else x for x in unsigned]))
    sig = pk.sign_msg_hash(sighash)
    signed = unsigned + [sig.v, sig.r, sig.s]
    raw = "0x02" + rlp_encode([to_bytes(x) if not isinstance(x, list) else x for x in signed]).hex()
    txh = rpc("eth_sendRawTransaction", [raw])
    print(f"sent nonce={nonce} gas={gas_limit} hash={txh}")
    return txh

def wait_receipt(txh, tries=60):
    for _ in range(tries):
        r = httpx.post(RPC, json={"jsonrpc": "2.0", "method": "eth_getTransactionReceipt",
                                  "params": [txh], "id": 1},
                       headers=H, timeout=20.0).json().get("result")
        if r:
            return r
        time.sleep(2)
    raise Exception(f"no receipt for {txh}")

# 1. quote + decision through the real backend path
quote = api("POST", "/quote", {"wallet": WALLET, "fromToken": USDC,
      "toToken": WETH, "amount": AMOUNT_USDC, "amountDecimals": 6})
print("quote out:", quote["expectedOutput"], "impact_bps:", quote["priceImpactBps"])
decision = api("POST", "/evaluate", {"wallet": WALLET, "pair": "USDC-WETH",
      "direction": "sell", "amount": AMOUNT_USDC,
      "slippage_bps": quote["slippageBps"],
      "impact_bps": quote["priceImpactBps"] or 0})
print("decision:", decision["decision"])
assert decision["decision"] == "ALLOW", f"expected ALLOW, got {decision}"

# 2. swap calldata from backend (includes ERC20 approval to router)
swap = api("POST", "/swap", {"wallet": WALLET, "fromToken": USDC,
      "toToken": WETH, "amount": AMOUNT_USDC, "amountDecimals": 6,
      "slippageBps": quote["slippageBps"]})
print("swap to:", swap["to"])

# 3. ERC20 approve USDC -> router (skip if allowance already covers).
# Traced on-chain: this router pulls input via direct transferFrom.
appr_sel = keccak(text="allowance(address,address)")[:4].hex()
allow_data = "0x" + appr_sel + encode(
    ["address", "address"],
    [to_checksum_address(WALLET),
     to_checksum_address(swap["approval"]["spender"])]).hex()
allow = int(rpc("eth_call", [{"to": USDC, "data": allow_data}, "latest"]), 16)
print("usdc->router allowance:", allow)
if allow < AMOUNT_WEI:
    h = send_tx(swap["approval"]["to"], swap["approval"]["data"], 100_000)
    rc = wait_receipt(h)
    print("approve receipt status:", rc["status"], "block:", int(rc["blockNumber"], 16))
    assert rc["status"] == "0x1", "approve failed"
else:
    print("approve skipped (allowance covers)")

# 4. exactInputSingle

h3 = send_tx(swap["to"], swap["data"], 500_000)
rc3 = wait_receipt(h3)
print("SWAP receipt status:", rc3["status"], "block:", int(rc3["blockNumber"], 16))
print("SWAP txHash:", h3)
assert rc3["status"] == "0x1", "swap reverted"

# 5. record real outcome to Sibyl
rec = api("POST", "/record", {"wallet": WALLET, "pair": "USDC-WETH",
      "direction": "sell", "amount": AMOUNT_USDC,
      "slippageBps": quote["slippageBps"],
      "impactBps": quote["priceImpactBps"] or 0,
      "outcome": "GOOD", "reason": "Successful execution", "txHash": h3})
print("recorded:", rec)
print("EXPLORER: https://sepolia.basescan.org/tx/" + h3)
