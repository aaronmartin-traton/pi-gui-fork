from __future__ import annotations

MODEL_TONES = {
    "m365-copilot": "magic",
    "auto": "magic",
    "quick": "Gpt_5_5_Chat",
    "think-deeper": "Gpt_5_5_Reasoning",
    "claude": "Claude_Sonnet",
    "claude-sonnet": "Claude_Sonnet",
    "claude-sonnet-4.5": "Claude_Sonnet",
    "claude-sonnet-4.6": "Claude_Sonnet",
    "claude-sonnet-5.5": "Claude_Sonnet",
    "claude-sonnet-5": "Claude_Sonnet_5",
    "claude-sonnet-think-deeper": "Claude_Sonnet_Reasoning",
    "claude-opus": "Claude_Opus",
    "claude-opus-5": "Claude_Opus",
    "claude-opus-5.5": "Claude_Opus",
    "claude-opus-4.5": "Claude_Opus",
    "gpt-5.5": "Gpt_5_5_Chat",
    "gpt-5.5-quick": "Gpt_5_5_Chat",
    "gpt-5.5-think-deeper": "Gpt_5_5_Reasoning",
    "gpt-5.6": "Gpt_5_6_Chat",
    "gpt-5.6-quick": "Gpt_5_6_Chat",
    "gpt-5.6-think-deeper": "Gpt_5_6_Reasoning",
    "gpt-6-think-deeper": "Gpt_6_Reasoning",
    "gpt-6-sol": "Gpt_6_Sol_Reasoning",
    "gpt-6.1-sol": "Gpt_61_Sol_Reasoning",
    "gpt-5.4": "Gpt_5_4_Reasoning",
    "gpt-5.4-think-deeper": "Gpt_5_4_Reasoning",
    "gpt-5.4-quick": "Gpt_5_4_Chat",
    "gpt-5.3": "Gpt_5_3_Chat",
    "gpt-5.3-quick": "Gpt_5_3_Chat",
    "gpt-5.3-think-deeper": "Gpt_5_3_Reasoning",
    "gpt-5.2": "Gpt_5_2_Chat",
    "gpt-5.2-quick": "Gpt_5_2_Chat",
    "gpt-5.2-think-deeper": "Gpt_5_2_Reasoning",
}

PAID_SCENARIO_TONES = {"Claude_Opus", "Gpt_6_Reasoning", "Claude_Sonnet_5"}
PAID_SCENARIO_MODELS = {"claude-sonnet-5.5"}
INCLUDED_SCENARIO_MODELS = {"claude-opus-4.5"}
METERED_BUDGETS = {
    "opus": ("ClaudeOpusQueryDaily", "ClaudeOpusQuery75"),
    "sonnet-5.5": ("ClaudeSonnet55QueryDaily", "ClaudeSonnet55QueryWeekly"),
}


def tone_for_model(model: str) -> str:
    tone = MODEL_TONES.get(model)
    if tone:
        return tone
    lowered = model.lower()
    if "opus" in lowered:
        return "Claude_Opus"
    if lowered.startswith("claude"):
        if "sonnet-5" in lowered and "sonnet-5.5" not in lowered and "sonnet-5-5" not in lowered:
            return "Claude_Sonnet_5"
        return "Claude_Sonnet"
    return MODEL_TONES["m365-copilot"]


def routing_for_model(model: str) -> tuple[str, str]:
    tone = tone_for_model(model)
    paid = (
        (tone in PAID_SCENARIO_TONES and model not in INCLUDED_SCENARIO_MODELS)
        or model in PAID_SCENARIO_MODELS
        or ("sonnet-5.5" in model.lower() or "sonnet-5-5" in model.lower())
    )
    return (
        "OfficeWebPaidCopilot" if paid else "OfficeWebIncludedCopilot",
        "Premium" if paid else "Starter",
    )


def default_framing(model: str) -> str:
    lowered = model.lower()
    tone = tone_for_model(model)
    if "sonnet-5.5" in lowered or "sonnet-5-5" in lowered or tone == "Claude_Sonnet_5":
        return "relay"
    if tone in {
        "Claude_Opus",
        "Claude_Sonnet",
        "Gpt_6_Reasoning",
        "Gpt_6_Sol_Reasoning",
        "Gpt_61_Sol_Reasoning",
    }:
        return "relay_batch"
    return "baseline"


def uses_agent(model: str, has_tools: bool) -> bool:
    tone = tone_for_model(model)
    if not has_tools:
        return model == "claude-opus-4.5"
    if tone == "Gpt_6_Reasoning":
        return False
    if tone.startswith("Claude_") and tone != "Claude_Opus":
        return False
    return True


def models_response() -> dict:
    return {
        "object": "list",
        "data": [
            {"id": model, "object": "model", "created": 0, "owned_by": "microsoft"}
            for model in MODEL_TONES
        ],
    }
