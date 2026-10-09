import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { GENERATIVE_UI_FENCE_LANGUAGE } from "../../../contracts/generative-ui";
import { GenerativeUiBlock } from "./generative-ui-block";
import {
  remarkWorkspaceFileLines,
  workspaceFileLineFromAnchorProps,
  type WorkspaceFileLine,
} from "./workspace-file-line";

const REMARK_PLUGINS = [remarkGfm];
const GENERATIVE_UI_CLASS = `language-${GENERATIVE_UI_FENCE_LANGUAGE}`;

function isGenerativeUiClass(className: unknown): boolean {
  return Array.isArray(className)
    ? className.includes(GENERATIVE_UI_CLASS)
    : typeof className === "string" && className.split(/\s+/).includes(GENERATIVE_UI_CLASS);
}

function markdownComponents(
  onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void,
): Components {
  return {
    // A ```openui-lang fence renders as a generative UI card instead of code.
    pre: ({ node, children }) => {
      const first = node?.children[0];
      const isGenerativeUi =
        first?.type === "element" &&
        first.tagName === "code" &&
        isGenerativeUiClass(first.properties.className);
      return isGenerativeUi ? <>{children}</> : <pre>{children}</pre>;
    },
    code: ({ className, children }) => {
      const code = String(children).replace(/\n$/, "");
      if (isGenerativeUiClass(className)) {
        return <GenerativeUiBlock source={code} />;
      }
      return <code className={className}>{code}</code>;
    },
    a: ({ href, children, ...props }) => {
      const file = onOpenWorkspaceFileLine ? workspaceFileLineFromAnchorProps(props) : null;
      if (file && onOpenWorkspaceFileLine) {
        return (
          <button
            className="message__file-link"
            data-end-line={file.endLine}
            data-line={file.line}
            data-path={file.path}
            data-testid="workspace-file-link"
            type="button"
            onClick={() => onOpenWorkspaceFileLine(file)}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} rel="noreferrer" target="_blank">
          {children}
        </a>
      );
    },
    table: ({ children }) => (
      <div className="message__table-scroll">
        <table>{children}</table>
      </div>
    ),
  };
}

const PLAIN_MARKDOWN_COMPONENTS = markdownComponents();

// Memoized: remark parsing is the dominant render cost on long threads, and the
// timeline re-renders on every streaming tick. `text` is a string, so shallow
// comparison skips the re-parse for every message except the one still growing.
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  workspacePath,
  onOpenWorkspaceFileLine,
  annotationRoot = false,
}: {
  readonly text: string;
  /** Marks this text as what transcript annotations anchor to. */
  readonly annotationRoot?: boolean;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
}) {
  const components = useMemo(
    () =>
      onOpenWorkspaceFileLine
        ? markdownComponents(onOpenWorkspaceFileLine)
        : PLAIN_MARKDOWN_COMPONENTS,
    [onOpenWorkspaceFileLine],
  );
  const remarkPlugins = useMemo(
    () =>
      onOpenWorkspaceFileLine
        ? [remarkGfm, remarkWorkspaceFileLines(workspacePath ?? null)]
        : REMARK_PLUGINS,
    [onOpenWorkspaceFileLine, workspacePath],
  );
  return (
    <div className="message__content" data-annotation-root={annotationRoot ? "" : undefined}>
      <ReactMarkdown components={components} remarkPlugins={remarkPlugins}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
