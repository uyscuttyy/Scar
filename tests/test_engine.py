import sys
sys.path.insert(0, '/home/uyscutty/projects/scar/src')
import engine
import pytest

def test_build_situation():
    sit = engine.build_situation('0xabc', 'USDC-WETH', 'sell', 1.0, 50, 10)
    assert sit['pair'] == 'USDC-WETH'
    assert sit['direction'] == 'sell'
    assert sit['amount'] == 1.0
    assert sit['slippage_bps'] == 50
    assert sit['impact_bps'] == 10
    assert sit['wallet'] == '0xabc'

def test_evaluate_no_memories(monkeypatch):
    # Mock sibyl_client.get_memories to return empty list
    monkeypatch.setattr(engine, 'sibyl_client', type('Mock', (), {
        'get_memories': lambda *a, **k: []
    })())
    sit = engine.build_situation('0xabc', 'USDC-WETH', 'sell', 1.0, 50, 10)
    decision = engine.evaluate(sit)
    assert decision['decision'] == 'ALLOW'
    assert decision['code'] == 'NO_RELEVANT_MEMORY'

def test_evaluate_deny(monkeypatch):
    # Return a bad memory with high importance
    monkeypatch.setattr(engine, 'sibyl_client', type('Mock', (), {
        'get_memories': lambda *a, **k: [
            {'importance': 80, 'body': {'pair': 'USDC-WETH', 'direction': 'sell',
                                       'amount': 1.0, 'slippageBps': 60, 'impactBps': 5,
                                       'outcome': 'FAILED', 'txHash': '0xdead'}}
        ]
    })())
    sit = engine.build_situation('0xabc', 'USDC-WETH', 'sell', 1.0, 50, 10)
    decision = engine.evaluate(sit)
    assert decision['decision'] == 'DENY'
    assert decision['code'] == 'REPEAT_BAD_CONDITIONS'
    assert decision['memory']['txHash'] == '0xdead'

def test_suggested_safer_amount():
    # Should reduce amount when slippage high
    sugg = engine.suggested_safer_amount({'slippageBps': 200, 'impactBps': 0}, 1.0)
    assert sugg < 1.0
    # Should not reduce if already low
    sugg2 = engine.suggested_safer_amount({'slippageBps': 50, 'impactBps': 0}, 1.0)
    assert sugg2 == 1.0

def test_record_experience_importance():
    # GOOD trade low importance
    exp = engine.record_experience({'pair': 'USDC-WETH', 'direction': 'buy', 'amount': 1.0,
                                   'slippageBps': 10, 'impactBps': 5, 'gasUsed': 100000,
                                   'txHash': '0x123'}, 'GOOD')
    assert exp['importance'] == 25  # baseline
    assert exp['stored'] is False
    assert exp['journal'] is True
    # FAILED trade higher importance
    exp2 = engine.record_experience({'pair': 'USDC-WETH', 'direction': 'sell', 'amount': 0.5,
                                     'slippageBps': 80, 'impactBps': 20, 'gasUsed': 150000,
                                     'txHash': '0x456'}, 'FAILED')
    assert exp2['importance'] >= 30
    assert exp2['stored'] is True