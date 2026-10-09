import { createContext, memo, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createParser, type ElementNode } from "@openuidev/lang-core";
import { generativeUiLibrary } from "../../../contracts/generative-ui";

/**
 * Renders one ```openui-lang fence from an assistant message as a small card.
 * The parser is permissive: while a message streams, the fence is partial and
 * we render whatever has resolved so far, so the card grows in place.
 */

export interface GenerativeUiActions {
  /** Puts a suggested follow-up into the composer for the user to send. */
  readonly onFollowUp: (prompt: string) => void;
}

export const GenerativeUiActionsContext = createContext<GenerativeUiActions | null>(null);

/** Follow-up buttons fill the composer and focus it; the user still presses Send. */
export function useGenerativeUiActions(
  setComposerDraft: (draft: string) => void,
  focusComposer: () => void,
): GenerativeUiActions {
  // The focus helper changes identity every render; a ref keeps the actions stable.
  const focusComposerRef = useRef(focusComposer);
  focusComposerRef.current = focusComposer;
  return useMemo(
    () => ({
      onFollowUp: (prompt: string) => {
        setComposerDraft(prompt);
        focusComposerRef.current();
      },
    }),
    [setComposerDraft],
  );
}

// One parser for the app; parse() is pure per call.
let sharedParser: ReturnType<typeof createParser> | null = null;
function parser() {
  sharedParser ??= createParser(generativeUiLibrary.toJSONSchema());
  return sharedParser;
}

export const GenerativeUiBlock = memo(function GenerativeUiBlock({
  source,
}: {
  readonly source: string;
}) {
  const result = useMemo(() => {
    try {
      return parser().parse(source);
    } catch {
      return null;
    }
  }, [source]);
  if (!result?.root) {
    // Nothing renderable yet (or invalid): fall back to the raw source so no answer is lost.
    return (
      <pre className="genui-fallback">
        <code>{source}</code>
      </pre>
    );
  }
  return (
    <div className="genui" data-testid="generative-ui">
      <GenNode node={result.root} />
    </div>
  );
});

function GenNode({ node }: { readonly node: unknown }): ReactNode {
  if (Array.isArray(node)) {
    return (node as readonly unknown[]).map((child, index) => <GenNode key={index} node={child} />);
  }
  if (typeof node === "string" || typeof node === "number") {
    return <p className="genui-text">{String(node)}</p>;
  }
  if (!isElement(node)) {
    return null;
  }
  const props = node.props;
  switch (node.typeName) {
    case "Card":
      return (
        <section className="genui-card">
          {str(props.title) ? <h3 className="genui-card__title">{str(props.title)}</h3> : null}
          <div className="genui-stack">
            <GenNode node={props.children} />
          </div>
        </section>
      );
    case "Row":
      return (
        <div className="genui-row">
          <GenNode node={props.children} />
        </div>
      );
    case "Text":
      return <p className="genui-text">{str(props.text)}</p>;
    case "Heading":
      return <h4 className="genui-heading">{str(props.text)}</h4>;
    case "Callout": {
      const tone = ["info", "success", "warning", "error"].includes(str(props.tone))
        ? str(props.tone)
        : "info";
      return (
        <div className={`genui-callout genui-callout--${tone}`} role="note">
          <div className="genui-callout__title">{str(props.title)}</div>
          {str(props.body) ? <div className="genui-callout__body">{str(props.body)}</div> : null}
        </div>
      );
    }
    case "Stat":
      return (
        <div className="genui-stat">
          <div className="genui-stat__label">{str(props.label)}</div>
          <div className="genui-stat__value">{str(props.value)}</div>
          {str(props.note) ? <div className="genui-stat__note">{str(props.note)}</div> : null}
        </div>
      );
    case "Table":
      return <GenTable columns={strings(props.columns)} rows={rows(props.rows)} />;
    case "BarChart":
      return (
        <GenBarChart
          title={str(props.title)}
          labels={strings(props.labels)}
          values={numbers(props.values)}
          unit={str(props.unit)}
        />
      );
    case "Steps":
      return (
        <ol className="genui-steps">
          {strings(props.items).map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ol>
      );
    case "Checklist":
      return <GenChecklist items={strings(props.items)} />;
    case "FollowUp":
      return <GenFollowUp label={str(props.label)} prompt={str(props.prompt)} />;
    default:
      return null;
  }
}

function GenTable({
  columns,
  rows: tableRows,
}: {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}) {
  return (
    <div className="message__table-scroll">
      <table className="genui-table">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tableRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((_, cellIndex) => (
                <td key={cellIndex}>{row[cellIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GenBarChart({
  title,
  labels,
  values,
  unit,
}: {
  readonly title: string;
  readonly labels: readonly string[];
  readonly values: readonly number[];
  readonly unit: string;
}) {
  const max = Math.max(0, ...values);
  return (
    <figure className="genui-bars">
      {title ? <figcaption className="genui-heading">{title}</figcaption> : null}
      {labels.map((label, index) => {
        const value = values[index] ?? 0;
        const width = max > 0 ? Math.max(0, (value / max) * 100) : 0;
        return (
          <div className="genui-bars__row" key={index}>
            <span className="genui-bars__label">{label}</span>
            <span className="genui-bars__track">
              <span className="genui-bars__fill" style={{ width: `${width}%` }} />
            </span>
            <span className="genui-bars__value">
              {value.toLocaleString()}
              {unit}
            </span>
          </div>
        );
      })}
    </figure>
  );
}

function GenChecklist({ items }: { readonly items: readonly string[] }) {
  const [done, setDone] = useState<ReadonlySet<number>>(() => new Set());
  return (
    <ul className="genui-checklist">
      {items.map((item, index) => (
        <li key={index}>
          <label>
            <input
              type="checkbox"
              checked={done.has(index)}
              onChange={() =>
                setDone((current) => {
                  const next = new Set(current);
                  if (!next.delete(index)) next.add(index);
                  return next;
                })
              }
            />
            <span>{item}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function GenFollowUp({ label, prompt }: { readonly label: string; readonly prompt: string }) {
  const actions = useContext(GenerativeUiActionsContext);
  if (!label) return null;
  return (
    <button
      type="button"
      className="genui-followup"
      data-testid="generative-ui-follow-up"
      disabled={!actions || !prompt}
      title={prompt}
      onClick={() => actions?.onFollowUp(prompt)}
    >
      {label}
    </button>
  );
}

function isElement(value: unknown): value is ElementNode {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "element" &&
    typeof (value as { typeName?: unknown }).typeName === "string"
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str) : [];
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === "number" ? entry : Number(entry) || 0))
    : [];
}

function rows(value: unknown): string[][] {
  return Array.isArray(value) ? value.map(strings) : [];
}
