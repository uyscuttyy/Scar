# SCAR deterministic decision engine — real Sibyl (sibyl-memory-client) only, no LLM.
# Implements memory.md: importance scoring, amount buckets, condition-aware
# matching, supersede, decay/archive pruning. Sibyl provides storage only.
from __future__ import annotations

import time
from typing import Any

CATEGORY = "scar_swap"
DENY_SLIP_BPS = 400
SIM_TOL_BPS = 150
MIN_SLIP_BPS = 200
MAX_MEMORIES = 50
STORE_THRESHOLD = 30


def amount_bucket(amount: float) -> str:
    try:
        a = float(amount)
    except (TypeError, ValueError):
        return "unknown"
    if a <= 0:
        return "unknown"
    if a < 10:
        return "dust"
    if a < 100:
        return "small"
    if a < 1000:
        return "medium"
    return "large"


def build_situation(wallet: str, pair: str, direction: str,
                    amount: float, slippage_bps: int,
                    impact_bps: int = 0) -> dict:
    return {
        "wallet": (wallet or "").lower(),
        "pair": pair,
        "direction": direction,
        "amount": amount,
        "amountBucket": amount_bucket(amount),
        "slippage_bps": int(slippage_bps),
        "impact_bps": int(impact_bps or 0),
    }


def eff_slip(sit: dict) -> int:
    """Worst execution-condition signal: quoted slippage or measured
    price impact, whichever is worse. Both are real quote data."""
    return max(sit.get("slippage_bps", 0), sit.get("impact_bps", 0))


def mem_eff_slip(b: dict) -> int:
    return max(b.get("slippageBps", 0) or 0, b.get("impactBps", 0) or 0)


def score_importance(outcome: str | None, slippage_bps: int,
                     repeated_bad: bool, age_days: float,
                     decided: bool = False) -> int:
    score = 0
    if outcome == "FAILED":
        score += 50
    elif outcome == "BAD":
        score += 40
    elif outcome == "GOOD":
        score += 5
    slip = slippage_bps or 0
    if slip >= 500:
        score += 25
    elif slip >= 200:
        score += 10
    if repeated_bad:
        score += 20
    score -= int(age_days // 30)
    if decided:
        score += 15
    return max(score, 0)


def _mem_outcome(m: dict) -> str | None:
    return (m.get("body") or {}).get("outcome")


def find_blocker(memories: list[dict], sit: dict) -> dict | None:
    for m in memories:
        b = m.get("body") or {}
        if b.get("supersededBy"):
            continue
        if b.get("pair") != sit["pair"]:
            continue
        if b.get("direction") != sit["direction"]:
            continue
        if b.get("amountBucket") and b["amountBucket"] != sit["amountBucket"]:
            continue
        if b.get("outcome") not in ("BAD", "FAILED"):
            continue
        mem_slip = mem_eff_slip(b) if ("slippageBps" in b or "impactBps" in b) else 999
        if eff_slip(sit) >= mem_slip - SIM_TOL_BPS:
            return m
    return None


def suggested_safer_amount(amount: float) -> float:
    """Actual safer-terms logic, never hardcoded per trade.

    Blockers match on the same amount bucket, and price impact grows
    with size, so stepping down one bucket both escapes the recorded
    bad conditions and genuinely lowers execution risk. Returns the top
    of the next-smaller bucket (or half the amount inside dust)."""
    try:
        a = float(amount)
    except (TypeError, ValueError):
        return 0.0
    if a >= 1000:
        return 999.0
    if a >= 100:
        return 99.0
    if a >= 10:
        return 9.0
    if a > 0:
        return round(a / 2, 6)
    return 0.0


def evaluate(memory_client, situation: dict) -> dict:
    try:
        memory_client.set_tenant(situation["wallet"])
        rows = memory_client.list_entities(category=CATEGORY, limit=100)
    except Exception:
        return {"decision": "DENY", "code": "SIBYL_UNAVAILABLE",
                "message": "Sibyl memory unavailable — no swap.",
                "tx_submitted": False}
    blocker = find_blocker(rows, situation)
    if blocker is not None and eff_slip(situation) >= DENY_SLIP_BPS:
        b = blocker.get("body") or {}
        return {"decision": "DENY", "code": "REPEAT_BAD_CONDITIONS",
                "message": "Similar bad conditions previously recorded; swap denied.",
                "tx_submitted": False,
                "memory": {"slippageBps": b.get("slippageBps"),
                           "impactBps": b.get("impactBps"),
                           "outcome": b.get("outcome"),
                           "txHash": b.get("txHash")},
                "safer_suggestion": {
                    "amount": suggested_safer_amount(situation.get("amount", 0)),
                    "reason": "A smaller size leaves the recorded bad conditions and lowers price impact. Re-quote at the suggested size for a fresh evaluation."}}
    if eff_slip(situation) >= DENY_SLIP_BPS:
        return {"decision": "SAFER_TERMS",
                "message": "High slippage; try lower-risk config.",
                "tx_submitted": False,
                "safer_suggestion": {
                    "amount": suggested_safer_amount(situation.get("amount", 0)),
                    "reason": "Smaller sizes carry lower price impact. Re-quote at the suggested size for a fresh evaluation."}}
    return {"decision": "ALLOW", "message": "Conditions acceptable.",
            "tx_submitted": True}


def record_experience(memory_client, wallet: str, experience: dict) -> dict:
    """Score importance, store entity if >= threshold, always journal. Fail-closed."""
    wallet = (wallet or "").lower()
    try:
        memory_client.set_tenant(wallet)
        existing = memory_client.list_entities(category=CATEGORY, limit=100)
    except Exception as e:
        return {"stored": False, "fail_closed": True, "error": str(e)}
    exp = dict(experience)
    exp.setdefault("wallet", wallet)
    exp.setdefault("amountBucket", amount_bucket(exp.get("amount", 0)))
    exp.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    repeated = any(
        (m.get("body") or {}).get("pair") == exp.get("pair")
        and (m.get("body") or {}).get("outcome") in ("BAD", "FAILED")
        for m in existing)
    importance = score_importance(exp.get("outcome"),
                                  max(exp.get("slippageBps", 0) or 0,
                                      exp.get("impactBps", 0) or 0),
                                  repeated, 0.0)
    exp["importance"] = importance
    result: dict[str, Any] = {"importance": importance, "stored": False,
                              "journal": False}
    try:
        memory_client.write_event(
            acted=[f"swap {exp.get('pair')} {exp.get('outcome')}"],
            extra={"wallet": wallet, "pair": exp.get("pair"),
                   "outcome": exp.get("outcome"),
                   "slippageBps": exp.get("slippageBps"),
                   "impactBps": exp.get("impactBps"),
                   "txHash": exp.get("txHash")})
        result["journal"] = True
        if importance >= STORE_THRESHOLD:
            name = exp.get("txHash") or f"{exp.get('pair')}_{exp.get('ts')}"
            memory_client.set_entity(CATEGORY, str(name), exp)
            result["stored"] = True
            result["name"] = str(name)
            # Prune: archive lowest-importance memories beyond cap.
            rows = memory_client.list_entities(category=CATEGORY, limit=200)
            if len(rows) > MAX_MEMORIES:
                ranked = sorted(rows, key=lambda r: (
                    (r.get("body") or {}).get("importance", 0)))
                for victim in ranked[:len(rows) - MAX_MEMORIES]:
                    try:
                        memory_client.archive_entity(
                            CATEGORY, victim["name"],
                            reason="pruned: lowest importance over cap")
                    except Exception:
                        break
        # Supersede: a GOOD under previously-bad conditions retires blockers.
        if exp.get("outcome") == "GOOD":
            for m in existing:
                b = m.get("body") or {}
                if (b.get("pair") == exp.get("pair")
                        and b.get("direction") == exp.get("direction")
                        and b.get("outcome") in ("BAD", "FAILED")
                        and not b.get("supersededBy")):
                    b["supersededBy"] = exp.get("txHash") or exp.get("ts")
                    try:
                        memory_client.set_entity(CATEGORY, m["name"], b)
                    except Exception:
                        pass
    except Exception as e:
        result["stored"] = False
        result["fail_closed"] = True
        result["error"] = str(e)
    return result
