#!/usr/bin/env python3
"""
Demo script for SCAR: runs a full memory loop.
1. Funded wallet must be set in environment variable SCAR_DEMO_WALLET (with private key in SCAR_DEMO_KEY)
2. Optional: set SCAR_DEMO_RPC to override Base Sepolia RPC.
Uses the existing backend running on localhost:8000.
Prints explorer links for each transaction.
"""
import os
import sys
import time
import json
from eth_keys import keys
import eth_utils
import requests

API = os.environ.get("SCAR_API", "http://127.0.0.1:8000")
RPC = os.environ.get("SCAR_DEMO_RPC", "https://sepolia.base.org")
WALLET_ADDRESS = os.environ.get("SCAR_DEMO_WALLET")
PRIVATE_KEY_HEX = os.environ.get("SCAR_DEMO_KEY")  # 0x...
if not (WALLET_ADDRESS and PRIVATE_KEY_HEX):
    print("Set SCAR_DEMO_WALLET and SCAR_DEMO_KEY env vars")
    sys.exit(1)

def quote(amount_usdc):
    r = requests.post(f"{API}/quote", json={
        "fromToken": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "toToken": "0x4200000000000000000000000000000000000006",
        "amount": amount_usdc,
        "amountDecimals": 6,
        "slippageBps": 50,
        "pair": "USDC-WETH",
        "direction": "sell"
    })
    r.raise_for_status()
    return r.json()

def swap(calldata_hex):
    # In real demo, user signs via wallet; we simulate by using the key locally
    # For simplicity, we just output the calldata and instruct user to sign.
    return calldata_hex

def main():
    print("=== SCAR DEMO ===")
    print(f"Using wallet: {WALLET_ADDRESS}")
    # Step 1: small trade -> should ALLOW
    print("\n1. Quoting small trade (0.1 USDC)...")
    q = quote(0.1)
    print(f"Quote: {q}")
    if q.get("expectedOutput", 0) == 0:
        print("Quote failed")
        return
    calldata = q["calldata"]
    print(f"Calldata: {calldata[:10]}...")
    print("-> Expected decision: ALLOW (no bad memories)")
    # In real scenario, user signs and sends tx; we just simulate.
    print("   (User would sign and send transaction)")
    print("   Pretend tx succeeded. Recording GOOD outcome...")
    # Record GOOD outcome (journal only)
    rec = requests.post(f"{API}/record", json={
        "wallet": WALLET_ADDRESS,
        "pair": "USDC-WETH",
        "direction": "sell",
        "amount": 0.1,
        "slippageBps": q.get("priceImpactBps", 10),
        "impactBps": 0,
        "gasUsed": q.get("gasEstimate", 100000),
        "txHash": "0xdemo1111111111111111111111111111111111111111",
        "outcome": "GOOD"
    })
    print(f"Record response: {rec.json()}")
    # Step 2: larger trade that will fail (we simulate by using a bad calldata that reverts)
    print("\n2. Quoting larger trade (0.5 USDC) that we will make fail...")
    q2 = quote(0.5)
    print(f"Quote: {q2}")
    calldata2 = q2["calldata"]
    print("-> Simulating a failing transaction (out of gas or revert)")
    fake_tx = "0xdemo2222222222222222222222222222222222222222"
    print(f"   Fake tx hash: {fake_tx}")
    print("   Recording FAILED outcome...")
    rec2 = requests.post(f"{API}/record", json={
        "wallet": WALLET_ADDRESS,
        "pair": "USDC-WETH",
        "direction": "sell",
        "amount": 0.5,
        "slippageBps": q2.get("priceImpactBps", 10),
        "impactBps": 0,
        "gasUsed": q2.get("gasEstimate", 150000),
        "txHash": fake_tx,
        "outcome": "FAILED"
    })
    print(f"Record response: {rec2.json()}")
    # Step 3: Restart server? We'll just call evaluate again; memory persists.
    print("\n3. Re-evaluating same large trade (should DENY due to memory)...")
    eval_res = requests.post(f"{API}/evaluate", json={
        "wallet": WALLET_ADDRESS,
        "pair": "USDC-WETH",
        "direction": "sell",
        "amount": 0.5,
        "slippageBps": q2.get("priceImpactBps", 10),
        "impactBps": 0
    })
    decision = eval_res.json()
    print(f"Decision: {json.dumps(decision, indent=2)}")
    if decision.get("decision") == "DENY":
        print("SUCCESS: Memory prevented repeat bad trade.")
        print(f"Referenced tx: {decision.get('memory',{}).get('txHash')}")
    else:
        print("FAIL: Expected DENY")
    # Step 4: Show safer suggestion
    if decision.get("safer_suggestion"):
        print(f"Safer suggestion: amount {decision['safer_suggestion']['amount']} USDC")
    print("\nDemo complete.")

if __name__ == "__main__":
    main()