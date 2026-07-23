"use client";

import { CheckCircle2, ChevronDown, TerminalSquare, XCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { ChatMessage } from "@app/contracts";
import { parseToolResult } from "../lib/tool-result";

function ToolResult({ content }: { content: string }) {
  const result = parseToolResult(content);
  const StatusIcon = result.status === "success" ? CheckCircle2 : XCircle;

  return <article className={`tool-result ${result.status}`}>
    <div className="tool-result-heading">
      <StatusIcon size={17} aria-hidden="true" />
      <div>
        <strong>{result.title}</strong>
        <span>{result.status === "success" ? "The tool finished successfully." : "The tool returned an error."}</span>
      </div>
    </div>
    <div className="tool-result-summary">
      <span>Output</span>
      <code>{result.summary}</code>
    </div>
    <details className="tool-result-details">
      <summary><TerminalSquare size={14} aria-hidden="true" /><span>Technical details</span><ChevronDown className="tool-result-chevron" size={14} aria-hidden="true" /></summary>
      <pre>{result.detail}</pre>
    </details>
  </article>;
}

export function Message({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return <ToolResult content={message.content} />;
  return <article className={`message ${message.role}`}>
    <div className="message-avatar">{message.role === "user" ? "You" : "C"}</div>
    <div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{message.content}</ReactMarkdown></div>
  </article>;
}
