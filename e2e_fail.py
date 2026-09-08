"""SCAR E2E part 2: real on-chain failure -> FAILED memory -> future DENY."""
import time
import httpx
from eth_abi import encode
from eth_utils import keccak, to_checksum_address
from eth_keys import keys

RPC = "https://sepolia.base.org"
API = "http://127.0.0.1:8000"
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
WETH = "0x4200000000000000000000000000000000000006"
CHAIN = 84532
H = {"User-Agent": "scar/1.0", "Content-Type": "application/json"}
AMOUNT_USDC = 0.5
AMOUNT_WEI = int(AMOUNT_USDC * 10**6)

pk = keys.PrivateKey(bytes.fromhex(open("/tmp/scar_testkey").read().strip().removeprefix("0x")))
WALLET = pk.public_key.to_checksum_address()

def rpc_call(method, params):
    r = httpx.post(RPC, json={"jsonrpc": "2.0", "method": method,
                              "params": params, "id": 1},
                   headers=H, timeout=20.0)
    j = r.json()
    if "error" in j:
        raise Exception(f"RPC {method}: {j['error']}")
    return j["result"]

def api_post(path, body):
    r = httpx.post(API + path, json=body, timeout=60.0)
    r.raise_for_status()
    return r.json()

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

def send_tx(to_addr, data_hex, gas_limit, value=0):
    nonce = int(rpc_call("eth_getTransactionCount", [WALLET, "pending"]), 16)
    base = int(rpc_call("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
    prio, maxfee = 1_000_000, base * 2 + 1_000_000
    unsigned = [CHAIN, nonce, prio, maxfee, gas_limit,
                bytes.fromhex(to_addr[2:]), value,
                bytes.fromhex(data_hex[2:] if data_hex.startswith("0x") else data_hex), []]
    sighash = keccak(b"\x02" + rlp_encode([to_bytes(x) if not isinstance(x, list) else x for x in unsigned]))
    sig = pk.sign_msg_hash(sighash)
    signed = unsigned + [sig.v, sig.r, sig.s]
    raw = "0x02" + rlp_encode([to_bytes(x) if not isinstance(x, list) else x for x in signed]).hex()
    txh = rpc_call("eth_sendRawTransaction", [raw])
    print(f"sent nonce={nonce} hash={txh}")
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

# 1. fresh quote for 0.5 USDC
quote = api_post("/quote", {"wallet": WALLET, "fromToken": USDC,
      "toToken": WETH, "amount": AMOUNT_USDC, "amountDecimals": 6})
print("quote out:", quote["expectedOutput"], "impact:", quote["priceImpactBps"])

# 2. build swap calldata but rig amountOutMinimum to 2x quote:
# guarantees an on-chain "Too little received" revert — a REAL failure.
swap = api_post("/swap", {"wallet": WALLET, "fromToken": USDC,
      "toToken": WETH, "amount": AMOUNT_USDC, "amountDecimals": 6,
      "slippageBps": quote["slippageBps"]})
from eth_abi import decode as abi_decode
tIn, tOut, fee, rec, aIn, aMin, sqrtL = abi_decode(
    ["(address,address,uint24,address,uint256,uint256,uint160)"],
    bytes.fromhex(swap["data"][10:]))[0]
rigged_min = quote["expectedOutput"] * 2
sel = keccak(text="exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")[:4]
rigged = "0x" + sel.hex() + encode(
    ["(address,address,uint24,address,uint256,uint256,uint160)"],
    [[to_checksum_address(tIn), to_checksum_address(tOut), fee,
      to_checksum_address(rec), aIn, rigged_min, sqrtL]]).hex()
print(f"rigged min {rigged_min} vs quoted {quote['expectedOutput']}")

h = send_tx(swap["to"], rigged, 500_000)
rc = wait_receipt(h)
print("FAIL-TX receipt status:", rc["status"], "block:", int(rc["blockNumber"], 16))
assert rc["status"] == "0x0", "expected a reverting tx"
print("FAIL txHash:", h)

# 3. record the REAL failure
rec_out = api_post("/record", {"wallet": WALLET, "pair": "USDC-WETH",
      "direction": "sell", "amount": AMOUNT_USDC,
      "slippageBps": quote["slippageBps"],
      "impactBps": quote["priceImpactBps"] or 0,
      "outcome": "FAILED", "reason": "Transaction reverted on-chain",
      "txHash": h})
print("recorded:", rec_out)
assert rec_out.get("stored") is True, "FAILED memory must persist"

# 4. similar future swap must now DENY with zero tx
d = api_post("/evaluate", {"wallet": WALLET, "pair": "USDC-WETH",
      "direction": "sell", "amount": AMOUNT_USDC,
      "slippage_bps": quote["slippageBps"],
      "impact_bps": quote["priceImpactBps"] or 0})
print("post-failure decision:", d["decision"], d.get("code"))
print("EXPLORER: https://sepolia.basescan.org/tx/" + h)
