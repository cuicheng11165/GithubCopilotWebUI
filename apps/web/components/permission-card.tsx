"use client";

import { ExternalLink, FileCode2, Play, TerminalSquare } from "lucide-react";
import { CONTINUE_PERMISSION_SCOPE, type PermissionRequest } from "@app/contracts";

export function PermissionCard({ request, onDecision }: { request: PermissionRequest; onDecision: (decision: "approve-once" | "deny") => Promise<void> }) {
  const continuing = request.scope === CONTINUE_PERMISSION_SCOPE;
  const Icon = continuing ? Play : request.scope === "shell" ? TerminalSquare : request.scope === "url" ? ExternalLink : FileCode2;
  const expires = new Date(request.expiresAt).toLocaleTimeString();
  return <article className={`permission-card${continuing ? " continue" : ""}`}>
    <div className="permission-icon"><Icon size={18} /></div>
    <div className="permission-body">
      <p className="eyebrow">{continuing ? "CONTINUE?" : "APPROVAL REQUIRED"}</p>
      <strong>{request.intention}</strong>
      <pre>{request.display}</pre>
      <small>{continuing ? `If you don't answer by ${expires}, this turn stops.` : `Expires ${expires}`}</small>
      <div className="permission-actions">
        <button className="button secondary small" onClick={() => void onDecision("deny")}>{continuing ? "Stop" : "Deny"}</button>
        <button className="button primary small" onClick={() => void onDecision("approve-once")}>{continuing ? "Continue" : "Approve once"}</button>
      </div>
    </div>
  </article>;
}
