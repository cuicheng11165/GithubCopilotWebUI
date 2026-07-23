"use client";

import { AlertCircle, CheckCircle2, ChevronDown, LoaderCircle, TerminalSquare, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@app/contracts";
import { parseToolResult, type ToolResultView } from "../lib/tool-result";

const RUNNING_RESULT_LIMIT = 3;

function compactSummary(summary: string): string {
  const firstLine = summary.split("\n").find((line) => line.trim())?.trim() ?? "";
  return firstLine.length > 96 ? `${firstLine.slice(0, 96).trimEnd()}...` : firstLine;
}

function ToolActivityRow({ result }: { result: ToolResultView }) {
  const StatusIcon = result.status === "success" ? CheckCircle2 : XCircle;

  return <details className={`tool-activity-row ${result.status}`}>
    <summary>
      <StatusIcon size={14} aria-hidden="true" />
      <span>{result.title}</span>
      <code>{compactSummary(result.summary)}</code>
      <ChevronDown className="tool-activity-row-chevron" size={13} aria-hidden="true" />
    </summary>
    <div className="tool-activity-row-body">
      <div className="tool-activity-output"><span>Output</span><code>{result.summary}</code></div>
      <details className="tool-technical-details">
        <summary><TerminalSquare size={13} aria-hidden="true" />Technical details<ChevronDown size={13} aria-hidden="true" /></summary>
        <pre>{result.detail}</pre>
      </details>
    </div>
  </details>;
}

export function ToolActivityGroup({ messages, isRunning = false, runningTool }: {
  messages: ChatMessage[];
  isRunning?: boolean;
  runningTool?: string | null;
}) {
  const results = useMemo(() => messages.map((message) => parseToolResult(message.content)), [messages]);
  const errorCount = results.filter((result) => result.status === "error").length;
  const successCount = results.length - errorCount;
  const [expanded, setExpanded] = useState(isRunning);
  const [showAllRunning, setShowAllRunning] = useState(false);
  const userToggled = useRef(false);
  const previousRunning = useRef(isRunning);

  useEffect(() => {
    if (previousRunning.current !== isRunning && !userToggled.current) setExpanded(isRunning);
    if (!isRunning) setShowAllRunning(false);
    previousRunning.current = isRunning;
  }, [isRunning]);

  const hiddenRunningCount = isRunning && !showAllRunning ? Math.max(0, results.length - RUNNING_RESULT_LIMIT) : 0;
  const visibleResults = hiddenRunningCount > 0 ? results.slice(-RUNNING_RESULT_LIMIT) : results;
  const GroupIcon = isRunning ? LoaderCircle : errorCount > 0 ? AlertCircle : CheckCircle2;
  const actionLabel = results.length === 1 ? "action" : "actions";
  const title = isRunning
    ? results.length > 0 ? `Working · ${results.length} ${actionLabel} completed` : "Working"
    : `Completed ${results.length} ${actionLabel}`;
  const status = isRunning
    ? runningTool ? `Current: ${runningTool}` : "Processing the next step"
    : errorCount > 0 ? `${successCount} succeeded · ${errorCount} failed` : "All actions succeeded";

  return <section className={`tool-activity-group ${isRunning ? "running" : errorCount > 0 ? "has-errors" : "complete"}`}>
    <button className="tool-activity-header" type="button" aria-expanded={expanded} onClick={() => {
      userToggled.current = true;
      setExpanded((value) => !value);
    }}>
      <GroupIcon size={16} aria-hidden="true" />
      <span className="tool-activity-heading"><strong>{title}</strong><small>{status}</small></span>
      <span className="tool-activity-toggle">{expanded ? "Hide activity" : "Show activity"}</span>
      <ChevronDown className="tool-activity-chevron" size={15} aria-hidden="true" />
    </button>
    {expanded && <div className="tool-activity-list">
      {hiddenRunningCount > 0 && <button className="tool-activity-earlier" type="button" onClick={() => setShowAllRunning(true)}>
        Show {hiddenRunningCount} earlier {hiddenRunningCount === 1 ? "action" : "actions"}
      </button>}
      {visibleResults.map((result, index) => <ToolActivityRow key={messages[hiddenRunningCount > 0 ? index + hiddenRunningCount : index]?.id ?? index} result={result} />)}
      {isRunning && <div className="tool-activity-current"><LoaderCircle size={14} aria-hidden="true" /><span>{runningTool ?? "Processing the next step"}</span></div>}
    </div>}
  </section>;
}
