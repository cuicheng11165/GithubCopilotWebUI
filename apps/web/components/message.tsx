"use client";

import { TerminalSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { ChatMessage } from "@app/contracts";

export function Message({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return <article className="tool-result">
    <div className="tool-result-title"><TerminalSquare size={15} /><strong>Tool result</strong></div>
    <pre>{message.content}</pre>
  </article>;
  return <article className={`message ${message.role}`}>
    <div className="message-avatar">{message.role === "user" ? "You" : "C"}</div>
    <div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{message.content}</ReactMarkdown></div>
  </article>;
}
