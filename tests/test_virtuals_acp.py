"""Verify the Virtuals ACP integration is real (no mocks, no fakes).

Covers everything provable without registered-agent credentials:
1. SDK installed with the expected on-chain job API.
2. Base Sepolia chain config present (84532).
3. Live agent discovery against the production ACP API.
4. Backend endpoints wired and honest when unconfigured.
5. Client construction genuinely requires a deployed agent wallet
   (throwaway key must FAIL validation, proving the gate is real).
6. Memo parsing never invents assessments.

Run: .venv/bin/python tests/test_virtuals_acp.py (needs the server up
for checks 4; skips them otherwise with a warning, still asserts 1-3,5-6).
Exit non-zero on any failure.
"""
import json
import os
import secrets
import sys
import urllib.request

API = os.environ.get("SCAR_API", "http://127.0.0.1:8000")
FAILURES = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def get(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": "scar-test/1.0"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def post(path, body):
    req = urllib.request.Request(
        API + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "scar-test/1.0"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        return {"__http_error__": e.code}


# 1. SDK installed with the real job API.
from virtuals_acp.client import VirtualsACP
import importlib.metadata as meta
sdk_version = meta.version("virtuals-acp")
check("sdk installed", True)
print("  virtuals-acp version:", sdk_version)
check("sdk has browse_agents", hasattr(VirtualsACP, "browse_agents"))
check("sdk has initiate_job", hasattr(VirtualsACP, "initiate_job"))
check("sdk has get_job_by_onchain_id", hasattr(VirtualsACP, "get_job_by_onchain_id"))

# 2. Base Sepolia config.
from virtuals_acp.configs.configs import BASE_SEPOLIA_CONFIG_V2
check("base-sepolia config chain_id == 84532",
      BASE_SEPOLIA_CONFIG_V2.chain_id == 84532,
      f"got {BASE_SEPOLIA_CONFIG_V2.chain_id}")

# 3. Live discovery (unauthenticated REST, same call the SDK makes).
disco_req = urllib.request.Request(
    "https://acpx.virtuals.io/api/agents/v4/search?search=risk&top_k=3",
    headers={"User-Agent": "scar-test/1.0"})
agents = json.loads(urllib.request.urlopen(disco_req, timeout=30).read()).get("data", [])
check("live discovery returns agents", len(agents) > 0, f"got {len(agents)}")
if agents:
    print("  e.g.", agents[0].get("name"), (agents[0].get("walletAddress") or "")[:12])

# 4. Backend endpoints (needs server).
try:
    st = get("/specialist/status")
    check("status endpoint honest when unconfigured",
          st.get("configured") is False and st.get("code") == "SPECIALIST_UNCONFIGURED", str(st)[:120])
    co = post("/consult", {"wallet": "0xabc", "pair": "USDC-WETH", "direction": "sell",
                           "amount": 500, "slippage_bps": 50, "impact_bps": 450})
    check("consult refuses to invent an assessment",
          co.get("available") is False and "assessment" not in co, str(co)[:160])
except Exception as e:
    print("SKIP server checks (server not up):", type(e).__name__, str(e)[:100])

# 5. Throwaway key must FAIL on-chain validation (gate is real).
from virtuals_acp.contract_clients.contract_client_v2 import ACPContractClientV2
from eth_account import Account
throwaway = "0x" + secrets.token_hex(32)
try:
    ACPContractClientV2(agent_wallet_address=Account.from_key(throwaway).address,
                        wallet_private_key=throwaway, entity_id=1,
                        config=BASE_SEPOLIA_CONFIG_V2)
    check("throwaway agent rejected on-chain", False, "client built without a deployed wallet")
except Exception as e:
    check("throwaway agent rejected on-chain", "not deployed on-chain" in str(e), str(e)[:120])

# 6. Memo parsing never invents data.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from specialist import _parse_assessment
a = _parse_assessment('{"risk": "high", "recommended_max_amount": 5, "rationale": "thin pool"}')
check("parses real JSON memo", a["risk"] == "high" and a["recommended_max_amount"] == 5.0, str(a))
b = _parse_assessment("looks fine, low risk trade")
check("reads plain-text low risk", b["risk"] == "low" and b["recommended_max_amount"] is None, str(b))
c = _parse_assessment("garbage with no signal 12345")
check("unknown stays unknown, no invention",
      c["risk"] == "unknown" and c["recommended_max_amount"] is None, str(c))

print()
if FAILURES:
    print("FAILURES:", FAILURES)
    sys.exit(1)
print("ALL ACP CHECKS PASSED")
