"use client";

import { ExternalLink, TerminalSquare, FileCode2 } from "lucide-react";
import type { PermissionRequest } from "@app/contracts";

export function PermissionCard({ request, onDecision }: { request: PermissionRequest; onDecision: (decision: "approve-once" | "deny") => Promise<void> }) {
  const Icon = request.scope === "shell" ? TerminalSquare : request.scope === "url" ? ExternalLink : FileCode2;
  return <article className="permission-card">
    <div className="permission-icon"><Icon size={18} /></div>
    <div className="permission-body"><p className="eyebrow">APPROVAL REQUIRED</p><strong>{request.intention}</strong><pre>{request.display}</pre><small>Expires {new Date(request.expiresAt).toLocaleTimeString()}</small>
      <div className="permission-actions"><button className="button secondary small" onClick={() => void onDecision("deny")}>Deny</button><button className="button primary small" onClick={() => void onDecision("approve-once")}>Approve once</button></div>
    </div>
  </article>;
}
