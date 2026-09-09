# Scar specialist consultation via Virtuals ACP (real integration).
#
# Researched against virtuals-acp (ACP Python SDK, ACP v2 contracts):
# - Buyer flow: VirtualsACP(ACPContractClientV2(...)) -> browse_agents()
#   -> initiate_job(provider, service_requirement, fare) -> fund on
#   budget proposal -> provider submits -> evaluator completes.
# - Base Sepolia is a supported chain (BASE_SEPOLIA_CONFIG_V2, 84532).
# - Client construction validates the agent smart-wallet is deployed
#   on-chain, so a live job genuinely requires a registered agent.
#
# Required env (all three, else Scar decides alone):
#   VIRTUALS_AGENT_WALLET_ADDRESS  registered agent smart-wallet (base-sepolia)
#   VIRTUALS_WALLET_PRIVATE_KEY    whitelisted dev wallet key (funds escrow)
#   VIRTUALS_ENTITY_ID             Service Registry entity id
# Optional:
#   VIRTUALS_SPECIALIST_KEYWORD    discovery keyword (default: trading risk)
#   VIRTUALS_PROVIDER_ADDRESS      skip discovery, use this provider directly
#   VIRTUALS_MAX_FARE_USDC         fare cap in USDC (default: 0.10)
#   VIRTUALS_CONSULT_TIMEOUT_S     deliverable wait cap (default: 120)
#
# Nothing here is mocked: unconfigured => explicit unavailable, and every
# assessment string returned comes from a real provider memo. Scar stays
# the final decision-maker; the assessment is advisory only.
from __future__ import annotations

import json
import os
import time
from typing import Any


def status() -> dict:
    """Report whether a live ACP consultation is possible right now."""
    missing = [k for k in ("VIRTUALS_AGENT_WALLET_ADDRESS",
                           "VIRTUALS_WALLET_PRIVATE_KEY",
                           "VIRTUALS_ENTITY_ID")
               if not os.environ.get(k)]
    try:
        from virtuals_acp.configs.configs import BASE_SEPOLIA_CONFIG_V2  # noqa: F401
        sdk = True
    except Exception as e:  # pragma: no cover - env dependent
        sdk = False
        sdk_error = str(e)
    else:
        sdk_error = ""
    if not sdk:
        return {"configured": False, "code": "SPECIALIST_SDK_MISSING",
                "message": "virtuals-acp SDK not installed.", "error": sdk_error}
    if missing:
        return {"configured": False, "code": "SPECIALIST_UNCONFIGURED",
                "message": ("Specialist consultation needs a registered Virtuals agent: "
                            f"missing {', '.join(missing)}. Scar decides alone."),
                "missing": missing}
    return {"configured": True, "chain": "base-sepolia",
            "keyword": os.environ.get("VIRTUALS_SPECIALIST_KEYWORD", "trading risk")}


def _build_client():
    from virtuals_acp.client import VirtualsACP
    from virtuals_acp.contract_clients.contract_client_v2 import ACPContractClientV2
    from virtuals_acp.configs.configs import BASE_SEPOLIA_CONFIG_V2
    contract = ACPContractClientV2(
        agent_wallet_address=os.environ["VIRTUALS_AGENT_WALLET_ADDRESS"],
        wallet_private_key=os.environ["VIRTUALS_WALLET_PRIVATE_KEY"],
        entity_id=int(os.environ["VIRTUALS_ENTITY_ID"]),
        config=BASE_SEPOLIA_CONFIG_V2,
    )
    return VirtualsACP(acp_contract_clients=contract, skip_socket_connection=True)


def consult(situation: dict, context: str = "") -> dict:
    """Ask a specialist agent for a risk assessment of this trade.

    Synchronous with a bounded wait: discovery -> initiate job -> poll
    for the provider deliverable until COMPLETED or timeout. Any failure
    returns available=False with an explicit code; Scar must then decide
    alone (fail-safe, never an invented assessment)."""
    st = status()
    if not st["configured"]:
        return {"available": False, **st}

    timeout_s = float(os.environ.get("VIRTUALS_CONSULT_TIMEOUT_S", "120"))
    max_fare = float(os.environ.get("VIRTUALS_MAX_FARE_USDC", "0.10"))
    keyword = os.environ.get("VIRTUALS_SPECIALIST_KEYWORD", "trading risk")
    deadline = time.time() + timeout_s

    try:
        acp = _build_client()
    except Exception as e:
        return {"available": False, "code": "SPECIALIST_CLIENT_FAILED",
                "message": "Could not build ACP client (agent wallet must be "
                           "deployed on-chain). Scar decides alone.",
                "error": str(e)[:300]}

    try:
        provider = os.environ.get("VIRTUALS_PROVIDER_ADDRESS") or None
        if provider is None:
            agents = acp.browse_agents(keyword, top_k=3)
            with_offerings = [a for a in agents if getattr(a, "offerings", None)]
            pool = with_offerings or agents
            if not pool:
                return {"available": False, "code": "SPECIALIST_NONE_FOUND",
                        "message": f"No specialist agents found for '{keyword}'. "
                                   "Scar decides alone."}
            provider = pool[0].wallet_address
            provider_name = getattr(pool[0], "name", provider)
        else:
            provider_name = provider

        from virtuals_acp.fare import Fare, FareAmount
        fare = Fare.from_contract_address(
            acp.acp_contract_client.config.base_fare.contract_address,
            acp.acp_contract_client.config, chain_id=84532)
        fare_amount = FareAmount(fare.format_amount(max_fare), fare)

        requirement = {
            "task": "trade-risk-assessment",
            "pair": situation.get("pair"),
            "direction": situation.get("direction"),
            "amount": situation.get("amount"),
            "amountBucket": situation.get("amountBucket"),
            "slippage_bps": situation.get("slippage_bps"),
            "impact_bps": situation.get("impact_bps"),
            "note": ("Assess execution risk for this spot swap on Base Sepolia. "
                     "Reply with JSON: {\"risk\": \"high\"|\"medium\"|\"low\", "
                     "\"recommended_max_amount\": <number|null>, \"rationale\": <string>}."),
            "context": context,
        }
        job_id = acp.initiate_job(provider, requirement, fare_amount)

        from virtuals_acp.models import ACPJobPhase
        deliverable_text = ""
        while time.time() < deadline:
            job = acp.get_job_by_onchain_id(job_id)
            if job.phase == ACPJobPhase.COMPLETED:
                d = job.deliverable
                if isinstance(d, dict):
                    deliverable_text = d.get("content") or d.get("result") or json.dumps(d)
                elif d is not None:
                    deliverable_text = str(d)
                if not deliverable_text:
                    # Fall back to the completion memo content.
                    for m in job.memos:
                        if m.next_phase == ACPJobPhase.COMPLETED and m.content:
                            deliverable_text = m.content
                            break
                break
            time.sleep(5)

        if not deliverable_text:
            return {"available": False, "code": "SPECIALIST_TIMEOUT",
                    "message": "Specialist did not answer in time. Scar decides alone.",
                    "job_id": job_id, "provider": provider}

        assessment = _parse_assessment(deliverable_text)
        return {"available": True, "provider": provider,
                "provider_name": provider_name, "job_id": job_id,
                "assessment": assessment, "raw": deliverable_text[:2000]}
    except Exception as e:
        return {"available": False, "code": "SPECIALIST_ERROR",
                "message": "Specialist consultation failed. Scar decides alone.",
                "error": str(e)[:300]}


def _parse_assessment(text: str) -> dict[str, Any]:
    """Extract risk/max-amount from a provider memo without inventing data."""
    risk = "unknown"
    recommended: float | None = None
    rationale = text.strip()[:1000]
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            obj = json.loads(text[start:end + 1])
            if isinstance(obj, dict):
                r = str(obj.get("risk", "")).lower()
                if r in ("high", "medium", "low"):
                    risk = r
                v = obj.get("recommended_max_amount")
                if isinstance(v, (int, float)) and v > 0:
                    recommended = float(v)
                if isinstance(obj.get("rationale"), str) and obj["rationale"].strip():
                    rationale = obj["rationale"].strip()[:1000]
    except Exception:
        pass
    lowered = rationale.lower()
    if risk == "unknown":
        if any(w in lowered for w in ("high risk", "too risky", "do not", "don't", "avoid")):
            risk = "high"
        elif any(w in lowered for w in ("low risk", "looks fine", "acceptable", "safe")):
            risk = "low"
    return {"risk": risk, "recommended_max_amount": recommended,
            "rationale": rationale}
