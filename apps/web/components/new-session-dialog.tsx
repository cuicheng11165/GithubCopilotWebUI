"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { ApprovalMode, ApprovalScope, ModelSummary, RepositorySummary } from "@app/contracts";

interface Props {
  repositories: RepositorySummary[];
  models: ModelSummary[];
  onClose: () => void;
  onCreate: (value: { repositoryId: string; model: string; approvalMode: ApprovalMode; approvalScopes: ApprovalScope[] }) => Promise<void>;
}

export function NewSessionDialog({ repositories, models, onClose, onCreate }: Props) {
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "");
  const [model, setModel] = useState("auto");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("interactive");
  const [scopes, setScopes] = useState<ApprovalScope[]>([]);
  const [busy, setBusy] = useState(false);
  const selected = useMemo(() => repositories.find((repository) => repository.id === repositoryId), [repositories, repositoryId]);

  const toggleScope = (scope: ApprovalScope) => setScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
        <div className="dialog-header"><div><p className="eyebrow">NEW CONVERSATION</p><h2 id="new-session-title">Choose a workspace</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
        <label>Repository<select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>{repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.displayName}</option>)}</select></label>
        {selected && <div className="repo-preview"><span className={`status-dot ${selected.dirty ? "amber" : "green"}`} /><div><strong>{selected.branch ?? "Not a Git repository"}</strong><small>{selected.headSha?.slice(0, 8) ?? "Live working directory"} · {selected.skills.length} skills</small></div></div>}
        <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <fieldset><legend>Execution approval</legend>
          {(["interactive", "session-scoped", "allow-all"] as ApprovalMode[]).map((mode) => <label className="radio-row" key={mode}><input type="radio" name="mode" checked={approvalMode === mode} onChange={() => setApprovalMode(mode)} /><span><strong>{mode === "interactive" ? "Interactive" : mode === "session-scoped" ? "Session scoped" : "Allow all"}</strong><small>{mode === "interactive" ? "Confirm every shell, URL, and script action." : mode === "session-scoped" ? "Automatically allow selected capability groups." : "Automatically allow all sandboxed actions."}</small></span></label>)}
        </fieldset>
        {approvalMode === "session-scoped" && <div className="scope-grid">{(["shell", "url", "private-script"] as ApprovalScope[]).map((scope) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} /> {scope === "private-script" ? "Private scripts" : scope[0]?.toUpperCase() + scope.slice(1)}</label>)}</div>}
        {approvalMode === "allow-all" && <div className="warning-banner">Allow all can execute repository scripts and send repository content to public URLs without prompting. The repository mount remains read-only.</div>}
        <div className="dialog-footer"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!repositoryId || busy} onClick={() => { setBusy(true); void onCreate({ repositoryId, model, approvalMode, approvalScopes: approvalMode === "session-scoped" ? scopes : [] }).finally(() => setBusy(false)); }}>{busy ? "Creating…" : "Start conversation"}</button></div>
      </section>
    </div>
  );
}
