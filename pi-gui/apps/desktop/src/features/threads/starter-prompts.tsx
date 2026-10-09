/**
 * Plain-language starting points on the empty New thread screen, for people who do
 * not know what to ask a coding agent. Clicking one fills the composer; nothing is sent
 * until the person presses Send.
 */

interface StarterPrompt {
  readonly label: string;
  readonly prompt: string;
}

export const STARTER_PROMPTS: readonly StarterPrompt[] = [
  {
    label: "Summarize this folder",
    prompt:
      "Look through the files in this folder and give me a short, plain-language summary of what is here and what stands out.",
  },
  {
    label: "Check a spreadsheet",
    prompt:
      "Find the CSV or Excel exports in this folder, check them for problems (blank rows, duplicates, odd values) and tell me what you would fix. Don't change anything yet.",
  },
  {
    label: "Make a checklist",
    prompt: "Turn this into a step-by-step checklist I can tick off:\n\n",
  },
  {
    label: "Draft an email",
    prompt: "Help me write a short, friendly email about:\n\n",
  },
  {
    label: "Explain a file",
    prompt: "Explain this file in plain language, as if I'm new to the topic: ",
  },
];

export function StarterPrompts({ onPick }: { readonly onPick: (prompt: string) => void }) {
  return (
    <div className="starter-prompts" data-testid="starter-prompts">
      {STARTER_PROMPTS.map((starter) => (
        <button
          className="starter-prompts__chip"
          key={starter.label}
          type="button"
          onClick={() => onPick(starter.prompt)}
        >
          {starter.label}
        </button>
      ))}
    </div>
  );
}
