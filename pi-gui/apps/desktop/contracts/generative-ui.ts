import { createLibrary, defineComponent } from "@openuidev/lang-core";
import { z } from "zod";

/**
 * The generative UI catalog: the only components a model may emit inside an
 * ```openui-lang fence. Main uses it to write the system-prompt section; the
 * renderer uses the same schema to parse streamed fences and maps each name to
 * a React component. Keep both sides in sync by adding components here first.
 */

export const GENERATIVE_UI_FENCE_LANGUAGE = "openui-lang";

const Text = defineComponent({
  name: "Text",
  description: "A paragraph of plain text.",
  props: z.object({ text: z.string().describe("The text to show") }),
  component: null,
});

const Heading = defineComponent({
  name: "Heading",
  description: "A short section heading.",
  props: z.object({ text: z.string() }),
  component: null,
});

const Callout = defineComponent({
  name: "Callout",
  description: "A highlighted note: tips, warnings, success or error messages.",
  props: z.object({
    tone: z.enum(["info", "success", "warning", "error"]).describe("Color and icon"),
    title: z.string(),
    body: z.string().optional(),
  }),
  component: null,
});

const Stat = defineComponent({
  name: "Stat",
  description: "One headline number with a label, e.g. a total or a KPI.",
  props: z.object({
    label: z.string(),
    value: z.string().describe("Pre-formatted value, e.g. '$1.2M' or '42%'"),
    note: z.string().optional().describe("Small caption such as a change vs last month"),
  }),
  component: null,
});

const Table = defineComponent({
  name: "Table",
  description: "A data table. Every row has one string per column.",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }),
  component: null,
});

const BarChart = defineComponent({
  name: "BarChart",
  description: "A simple horizontal bar chart comparing a handful of values.",
  props: z.object({
    title: z.string().optional(),
    labels: z.array(z.string()),
    values: z.array(z.number()),
    unit: z.string().optional().describe("Suffix shown after each value, e.g. '%' or ' hrs'"),
  }),
  component: null,
});

const Steps = defineComponent({
  name: "Steps",
  description: "An ordered list of instructions the user should follow.",
  props: z.object({ items: z.array(z.string()) }),
  component: null,
});

const Checklist = defineComponent({
  name: "Checklist",
  description: "A to-do list. The user can tick items off.",
  props: z.object({ items: z.array(z.string()) }),
  component: null,
});

const FollowUp = defineComponent({
  name: "FollowUp",
  description:
    "A button that sends `prompt` back to you as the user's next message. Use for suggested next steps.",
  props: z.object({
    label: z.string().describe("Button text, 1-4 words"),
    prompt: z.string().describe("The full message to send when clicked"),
  }),
  component: null,
});

const Row = defineComponent({
  name: "Row",
  description: "Places children side by side (wraps on narrow screens). Good for Stat tiles.",
  props: z.object({ children: z.array(z.any()) }),
  component: null,
});

const Card = defineComponent({
  name: "Card",
  description: "The root container. A titled card that stacks its children vertically.",
  props: z.object({
    title: z.string().optional(),
    children: z.array(z.any()),
  }),
  component: null,
});

export const generativeUiLibrary = createLibrary({
  components: [
    Card,
    Row,
    Text,
    Heading,
    Callout,
    Stat,
    Table,
    BarChart,
    Steps,
    Checklist,
    FollowUp,
  ],
  root: "Card",
});

export type GenerativeUiComponentName =
  | "Card"
  | "Row"
  | "Text"
  | "Heading"
  | "Callout"
  | "Stat"
  | "Table"
  | "BarChart"
  | "Steps"
  | "Checklist"
  | "FollowUp";

/** System-prompt section appended for every turn while generative UI is on. */
export function generativeUiSystemPrompt(): string {
  return generativeUiLibrary.prompt({
    inlineMode: true,
    preamble: [
      "# Rich answers (optional)",
      "The chat window can render small interactive UI cards. Most answers should stay plain Markdown.",
      "Use a card only when it clearly helps a non-technical reader: summaries with numbers, comparisons,",
      "step-by-step instructions, checklists, or suggested next actions. Never put code edits in a card.",
    ].join("\n"),
    additionalRules: [
      "Use at most one ```openui-lang fence per answer, after any explanation text.",
      "Keep cards small: no more than about 12 components.",
      "Prefer FollowUp buttons over asking the user to type a long reply.",
    ],
    examples: [
      [
        'root = Card("Expense summary", [stats, chart, next])',
        'stats = Row([Stat("Total", "$4,210"), Stat("Top category", "Travel", "58% of spend")])',
        'chart = BarChart("By category", ["Travel", "Meals", "Software"], [2440, 980, 790], " USD")',
        'next = Row([FollowUp("Show details", "List every travel expense over $200"), FollowUp("Export", "Write this summary to expenses.md")])',
      ].join("\n"),
    ],
  });
}
