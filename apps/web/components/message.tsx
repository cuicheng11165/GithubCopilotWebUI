"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import type { ChatMessage } from "@app/contracts";

export function Message({ message }: { message: ChatMessage }) {
  return <article className={`message ${message.role}`}>
    <div className="message-avatar">{message.role === "user" ? "You" : "C"}</div>
    <div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{message.content}</ReactMarkdown></div>
  </article>;
}
