"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { RepositorySummary } from "@app/contracts";

interface Props {
  repositories: RepositorySummary[];
  modelAvailable: boolean;
  onClose: () => void;
  onCreate: (repositoryId: string) => Promise<void>;
}

export function NewSessionDialog({ repositories, modelAvailable, onClose, onCreate }: Props) {
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const selected = useMemo(() => repositories.find((repository) => repository.id === repositoryId), [repositories, repositoryId]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
        <div className="dialog-header"><div><p className="eyebrow">NEW CONVERSATION</p><h2 id="new-session-title">Choose a workspace</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
        <label>Repository<select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>{repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.displayName}</option>)}</select></label>
        {selected && <div className="repo-preview"><span className={`status-dot ${selected.dirty ? "amber" : "green"}`} /><div><strong>{selected.branch ?? "Not a Git repository"}</strong><small>{selected.headSha?.slice(0, 8) ?? "Live working directory"} · {selected.skills.length} skills</small></div></div>}
        {!modelAvailable && <div className="warning-banner">Loading available models…</div>}
        <div className="dialog-footer"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!repositoryId || !modelAvailable || busy} onClick={() => { setBusy(true); void onCreate(repositoryId).finally(() => setBusy(false)); }}>{busy ? "Creating…" : "Start conversation"}</button></div>
      </section>
    </div>
  );
}
