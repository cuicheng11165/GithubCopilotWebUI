"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Github, LoaderCircle, LogOut, Menu, Pencil, Plus, Send, ShieldAlert, Square, Trash2, X } from "lucide-react";
import type { ApprovalMode, ApprovalScope, AuthUser, ChatMessage, ChatSession, ModelSummary, PermissionRequest, RepositorySummary } from "@app/contracts";
import { ApiError, apiWrite, getMe, getModels, getRepositories, getRuntime, getSession, getSessions } from "../lib/api";
import { Message } from "./message";
import { NewSessionDialog } from "./new-session-dialog";
import { PermissionCard } from "./permission-card";

export function ChatApp() {
  const [me, setMe] = useState<AuthUser | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [skills, setSkills] = useState<Array<{ name: string; warning: string | null }>>([]);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([{ id: "auto", name: "Auto", supportsReasoning: false }]);
  const [sandboxBackend, setSandboxBackend] = useState<"local" | "container">("local");
  const [showCreate, setShowCreate] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const active = useMemo(() => sessions.find((session) => session.id === activeId) ?? null, [sessions, activeId]);

  const refreshSessions = useCallback(async () => { const data = await getSessions(); setSessions(data); if (!activeId && data[0]) setActiveId(data[0].id); }, [activeId]);
  useEffect(() => { void (async () => {
    try {
      const user = await getMe(); setMe(user);
      const [sessionData, repositoryData, runtimeData] = await Promise.all([getSessions(), getRepositories(), getRuntime()]);
      setSessions(sessionData); setRepositories(repositoryData); setSandboxBackend(runtimeData.sandboxBackend); setActiveId(sessionData[0]?.id ?? null);
      void getModels().then(setModels).catch(() => undefined);
    } catch (caught) { if (caught instanceof ApiError && caught.status === 401) window.location.href = "/login"; else setError(caught instanceof Error ? caught.message : "Failed to load the app"); }
  })(); }, []);

  useEffect(() => {
    if (!activeId) { setMessages([]); setPermissions([]); setSkills([]); setActiveTool(null); return; }
    setStreaming("");
    void getSession(activeId).then((detail) => { setMessages(detail.messages); setPermissions(detail.permissions); setSkills(detail.skills); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Failed to load session"));
    const events = new EventSource(`/api/sessions/${activeId}/events`, { withCredentials: true });
    const handle = (raw: Event) => {
      const payload = JSON.parse((raw as MessageEvent<string>).data) as { kind: string; data: Record<string, unknown>; turnId: string | null };
      if (payload.kind === "assistant.delta") setStreaming((value) => value + String(payload.data.deltaContent ?? ""));
      if (payload.kind === "assistant.message") {
        const content = String(payload.data.content ?? ""); setStreaming("");
        setMessages((current) => current.some((message) => message.turnId === payload.turnId && message.role === "assistant") ? current : [...current, { id: crypto.randomUUID(), sessionId: activeId, turnId: payload.turnId, role: "assistant", content, createdAt: new Date().toISOString() }]);
      }
      if (payload.kind === "tool.completed") {
        const id = String(payload.data.messageId ?? crypto.randomUUID());
        const content = String(payload.data.content ?? JSON.stringify(payload.data, null, 2));
        setMessages((current) => current.some((message) => message.id === id) ? current : [...current, { id, sessionId: activeId, turnId: payload.turnId, role: "tool", content, createdAt: new Date().toISOString() }]);
        setActiveTool(null);
      }
      if (payload.kind === "tool.started") setActiveTool(String(payload.data.toolName ?? payload.data.name ?? "Agent tool"));
      if (payload.kind === "permission.requested") setPermissions((current) => [...current.filter((item) => item.id !== payload.data.id), payload.data as unknown as PermissionRequest]);
      if (payload.kind === "permission.completed") setPermissions((current) => current.filter((item) => item.id !== payload.data.requestId));
      if (payload.kind === "turn.queued") setSessions((current) => current.map((item) => item.id === activeId ? { ...item, status: "queued" } : item));
      if (payload.kind === "turn.started") setSessions((current) => current.map((item) => item.id === activeId ? { ...item, status: "running" } : item));
      if (payload.kind === "permission.requested") setSessions((current) => current.map((item) => item.id === activeId ? { ...item, status: "waiting-approval" } : item));
      if (["turn.completed", "turn.failed", "turn.stopped", "session.updated"].includes(payload.kind)) void refreshSessions();
    };
    ["turn.queued", "turn.started", "assistant.delta", "assistant.message", "tool.started", "tool.completed", "permission.requested", "permission.completed", "turn.completed", "turn.failed", "turn.stopped", "session.updated"].forEach((kind) => events.addEventListener(kind, handle));
    return () => events.close();
  }, [activeId, refreshSessions]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming, permissions]);

  if (!me) return <div className="app-loading"><div className="brand-mark"><Bot size={24} /></div><span>Loading workspace…</span></div>;

  const createSession = async (input: { repositoryId: string; model: string; approvalMode: ApprovalMode; approvalScopes: ApprovalScope[] }) => {
    const session = await apiWrite<ChatSession>("/api/sessions", me.csrfToken, "POST", input);
    setSessions((current) => [session, ...current]); setActiveId(session.id); setShowCreate(false);
  };
  const send = async () => {
    const content = draft.trim(); if (!content || !active) return;
    setDraft(""); setStreaming("");
    setMessages((current) => [...current, { id: crypto.randomUUID(), sessionId: active.id, turnId: null, role: "user", content, createdAt: new Date().toISOString() }]);
    try { await apiWrite(`/api/sessions/${active.id}/messages`, me.csrfToken, "POST", { content }, { "Idempotency-Key": crypto.randomUUID() }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Message could not be sent"); }
  };
  const rename = async (session: ChatSession, title: string) => {
    if (!title.trim()) return; const updated = await apiWrite<ChatSession>(`/api/sessions/${session.id}`, me.csrfToken, "PATCH", { title: title.trim() });
    setSessions((current) => current.map((item) => item.id === updated.id ? updated : item)); setRenaming(null);
  };
  const updateSession = async (session: ChatSession, patch: Record<string, unknown>) => {
    const updated = await apiWrite<ChatSession>(`/api/sessions/${session.id}`, me.csrfToken, "PATCH", patch);
    setSessions((current) => current.map((item) => item.id === updated.id ? updated : item));
  };
  const remove = async (session: ChatSession) => {
    if (!window.confirm(`Permanently delete “${session.title}”? This cannot be undone.`)) return;
    await apiWrite(`/api/sessions/${session.id}`, me.csrfToken, "DELETE");
    const next = sessions.filter((item) => item.id !== session.id); setSessions(next); if (activeId === session.id) setActiveId(next[0]?.id ?? null);
  };

  return <main className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
      <div className="sidebar-top"><div className="sidebar-brand"><Github size={20} /><span>Copilot Workspace</span></div><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
      <button className="new-chat-button" onClick={() => setShowCreate(true)}><Plus size={17} /> New chat</button>
      <div className="session-label">CONVERSATIONS</div>
      <nav className="session-list">{sessions.map((session) => <div role="button" tabIndex={0} className={`session-row ${session.id === activeId ? "active" : ""}`} key={session.id} onClick={() => { setActiveId(session.id); if (window.innerWidth < 760) setSidebarOpen(false); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveId(session.id); }}>
        <span className={`status-dot ${session.status === "running" ? "pulse green" : session.status === "waiting-approval" ? "amber" : session.status === "error" ? "red" : "muted"}`} />
        <span className="session-copy">{renaming === session.id ? <input autoFocus defaultValue={session.title} onClick={(event) => event.stopPropagation()} onBlur={(event) => void rename(session, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void rename(session, event.currentTarget.value); if (event.key === "Escape") setRenaming(null); }} /> : <><strong>{session.title}</strong><small>{session.repositoryName}</small></>}</span>
        <span className="session-actions"><button aria-label="Rename" onClick={(event) => { event.stopPropagation(); setRenaming(session.id); }}><Pencil size={14} /></button><button aria-label="Delete" onClick={(event) => { event.stopPropagation(); void remove(session); }}><Trash2 size={14} /></button></span>
      </div>)}</nav>
      <div className="profile-row">{me.avatarUrl ? <img src={me.avatarUrl} alt="" /> : <div className="profile-placeholder">{me.login[0]?.toUpperCase()}</div>}<div><strong>{me.displayName ?? me.login}</strong><small>@{me.login}</small></div><button className="icon-button" aria-label="Sign out" onClick={() => void apiWrite("/api/auth/logout", me.csrfToken, "POST").then(() => { window.location.href = "/login"; })}><LogOut size={16} /></button></div>
    </aside>
    <section className="chat-panel">
      <header className="chat-header"><button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}><Menu size={19} /></button>{active ? <><div className="header-title"><strong>{active.title}</strong><span>{active.repositoryName} · {active.branch ?? "live"} {active.headSha ? `@ ${active.headSha.slice(0, 8)}` : ""}{active.dirty ? " · modified" : ""}</span></div><div className="header-controls"><select aria-label="Approval mode" className={`mode-pill mode-select ${active.approvalMode === "allow-all" ? "danger" : ""}`} value={active.approvalMode} onChange={(event) => void updateSession(active, { approvalMode: event.target.value, approvalScopes: event.target.value === "session-scoped" ? active.approvalScopes : [] })}><option value="interactive">interactive</option><option value="session-scoped">session-scoped</option><option value="allow-all">allow-all</option></select><select aria-label="Model" className="model-pill model-select" value={active.model} onChange={(event) => void updateSession(active, { model: event.target.value })}>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div></> : <div className="header-title"><strong>Copilot Workspace</strong><span>Select or create a conversation</span></div>}</header>
      {sandboxBackend === "local" && <div className="local-execution-banner"><ShieldAlert size={15} /> Local execution is not isolated. Approved commands and scripts can modify repositories and access host files.</div>}
      {!active ? <div className="empty-state"><div className="empty-icon"><Bot size={28} /></div><h1>Start with a repository</h1><p>Ask Copilot about live code, run approved commands, and use private repository skills.</p><button className="button primary" onClick={() => setShowCreate(true)}><Plus size={17} /> New chat</button></div> : <>
        {active.approvalMode === "allow-all" && <div className="allow-all-banner"><ShieldAlert size={15} /> Allow all is active. Commands, public URL requests, and private scripts run without approval.</div>}
        {active.approvalMode === "session-scoped" && <div className="session-scope-bar"><span>Auto approve for this session:</span>{(["shell", "url", "private-script"] as ApprovalScope[]).map((scope) => <label key={scope}><input type="checkbox" checked={active.approvalScopes.includes(scope)} onChange={() => void updateSession(active, { approvalScopes: active.approvalScopes.includes(scope) ? active.approvalScopes.filter((item) => item !== scope) : [...active.approvalScopes, scope] })} />{scope === "private-script" ? "Private scripts" : scope === "url" ? "URL" : "Shell"}</label>)}</div>}
        <div className="messages"><div className="context-strip"><span>{skills.length} skills loaded</span>{skills.filter((skill) => skill.warning).map((skill) => <span className="skill-warning" key={skill.name}>{skill.name}: {skill.warning}</span>)}</div>{messages.map((message) => <Message key={message.id} message={message} />)}{streaming && <Message message={{ id: "streaming", sessionId: active.id, turnId: null, role: "assistant", content: streaming + " ▍", createdAt: new Date().toISOString() }} />}{activeTool && <div className="tool-running"><LoaderCircle size={15} /> Running {activeTool}…</div>}{permissions.map((permission) => <PermissionCard key={permission.id} request={permission} onDecision={async (decision) => { await apiWrite(`/api/sessions/${active.id}/permissions/${permission.id}/respond`, me.csrfToken, "POST", { decision }); setPermissions((current) => current.filter((item) => item.id !== permission.id)); }} />)}<div ref={bottomRef} /></div>
        <div className="composer-wrap"><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Ask about ${active.repositoryName}…`} rows={1} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} /><div className="composer-bottom"><span>{sandboxBackend === "local" ? "Local execution · repository may be modified" : "Repository is read-only · isolated container"}</span>{["running", "queued", "waiting-approval"].includes(active.status) ? <button className="send-button stop" aria-label="Stop" onClick={() => void apiWrite(`/api/sessions/${active.id}/stop`, me.csrfToken, "POST")}><Square size={14} fill="currentColor" /></button> : <button className="send-button" aria-label="Send" disabled={!draft.trim()} onClick={() => void send()}><Send size={17} /></button>}</div></div><p className="composer-note">Copilot can make mistakes. Review command output and URL destinations.</p></div>
      </>}
    </section>
    {showCreate && <NewSessionDialog repositories={repositories} models={models} sandboxBackend={sandboxBackend} onClose={() => setShowCreate(false)} onCreate={createSession} />}
    {error && <div className="toast"><span>{error}</span><button onClick={() => setError(null)}><X size={15} /></button></div>}
  </main>;
}
