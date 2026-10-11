/**
 * Port of m365copilotproxy/catalog.py: model alias -> tone mappings plus the
 * routing, framing, and agent-selection decisions derived from them.
 */

export const MODEL_TONES: Readonly<Record<string, string>> = {
  "m365-copilot": "magic",
  auto: "magic",
  quick: "Gpt_5_5_Chat",
  "think-deeper": "Gpt_5_5_Reasoning",
  claude: "Claude_Sonnet",
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
};

export const PAID_SCENARIO_TONES: Readonly<Record<string, true>> = {
  Claude_Opus: true,
  Gpt_6_Reasoning: true,
  Claude_Sonnet_5: true,
};
export const PAID_SCENARIO_MODELS: Readonly<Record<string, true>> = {
  "claude-sonnet-5.5": true,
};
export const INCLUDED_SCENARIO_MODELS: Readonly<Record<string, true>> = {
  "claude-opus-4.5": true,
};
export const METERED_BUDGETS: Readonly<Record<string, readonly [string, string]>> = {
  opus: ["ClaudeOpusQueryDaily", "ClaudeOpusQuery75"],
  "sonnet-5.5": ["ClaudeSonnet55QueryDaily", "ClaudeSonnet55QueryWeekly"],
};

/** Fallback tone: the tone bound to the "m365-copilot" alias. */
const DEFAULT_TONE: string = MODEL_TONES["m365-copilot"] ?? "magic";

/** Tones served through the batched relay framing. */
const RELAY_BATCH_TONES: Readonly<Record<string, true>> = {
  Claude_Opus: true,
  Claude_Sonnet: true,
  Gpt_6_Reasoning: true,
  Gpt_6_Sol_Reasoning: true,
  Gpt_61_Sol_Reasoning: true,
};

export function toneForModel(model: string): string {
  // Own-key lookup only: "__proto__"/"constructor"/"toString" must miss like a
  // Python dict instead of resolving against Object.prototype.
  const tone = Object.hasOwn(MODEL_TONES, model) ? MODEL_TONES[model] : undefined;
  if (tone) {
    return tone;
  }
  const lowered = model.toLowerCase();
  if (lowered.includes("opus")) {
    return "Claude_Opus";
  }
  if (lowered.startsWith("claude")) {
    if (
      lowered.includes("sonnet-5") &&
      !lowered.includes("sonnet-5.5") &&
      !lowered.includes("sonnet-5-5")
    ) {
      return "Claude_Sonnet_5";
    }
    return "Claude_Sonnet";
  }
  return DEFAULT_TONE;
}

export function routingForModel(model: string): readonly [string, string] {
  const tone = toneForModel(model);
  const lowered = model.toLowerCase();
  const paid =
    (Object.hasOwn(PAID_SCENARIO_TONES, tone) && !Object.hasOwn(INCLUDED_SCENARIO_MODELS, model)) ||
    Object.hasOwn(PAID_SCENARIO_MODELS, model) ||
    lowered.includes("sonnet-5.5") ||
    lowered.includes("sonnet-5-5");
  return paid ? ["OfficeWebPaidCopilot", "Premium"] : ["OfficeWebIncludedCopilot", "Starter"];
}

export function defaultFraming(model: string): string {
  const lowered = model.toLowerCase();
  const tone = toneForModel(model);
  if (
    lowered.includes("sonnet-5.5") ||
    lowered.includes("sonnet-5-5") ||
    tone === "Claude_Sonnet_5"
  ) {
    return "relay";
  }
  if (Object.hasOwn(RELAY_BATCH_TONES, tone)) {
    return "relay_batch";
  }
  return "baseline";
}

export function usesAgent(model: string, hasTools: boolean): boolean {
  const tone = toneForModel(model);
  if (!hasTools) {
    return model === "claude-opus-4.5";
  }
  if (tone === "Gpt_6_Reasoning") {
    return false;
  }
  if (tone.startsWith("Claude_") && tone !== "Claude_Opus") {
    return false;
  }
  return true;
}

export function modelsResponse(): {
  object: string;
  data: Array<{ id: string; object: string; created: number; owned_by: string }>;
} {
  return {
    object: "list",
    data: Object.keys(MODEL_TONES).map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "microsoft",
    })),
  };
}
