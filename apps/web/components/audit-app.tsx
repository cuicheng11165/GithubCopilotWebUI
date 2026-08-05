"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, MessageSquareText, RefreshCw, Search, Users } from "lucide-react";
import type { AuditSessionDetail, AuditSessionSummary } from "@app/contracts";
import { getAuditSession, getAuditSessions } from "../lib/api";
import { groupConversationMessages } from "../lib/conversation-items";
import { Message } from "./message";
import { ToolActivityGroup } from "./tool-activity-group";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AuditApp() {
  const [sessions, setSessions] = useState<AuditSessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditSessionDetail | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadSessions(query = search) {
    setLoading(true);
    setError(null);
    try {
      const result = await getAuditSessions(query);
      setSessions(result.sessions);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载会话失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadSessions(""); }, []);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setDetail(null);
    setError(null);
    void getAuditSession(selectedId).then(setDetail).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "加载对话失败");
    });
  }, [selectedId]);

  const userCount = useMemo(() => new Set(sessions.map((session) => session.user.id)).size, [sessions]);
  const conversationItems = useMemo(() => groupConversationMessages(detail?.messages ?? []), [detail]);

  return <main className="audit-shell">
    <header className="audit-header">
      <div>
        <p className="eyebrow">QUALITY REVIEW</p>
        <h1>对话审计</h1>
        <span>查看所有用户的完整对话内容</span>
      </div>
      <a className="button secondary" href="/"><ArrowLeft size={15} />返回对话</a>
    </header>

    <section className="audit-stats">
      <div><Users size={18} /><span><strong>{userCount}</strong> 当前列表用户</span></div>
      <div><MessageSquareText size={18} /><span><strong>{total}</strong> 个会话</span></div>
    </section>

    <section className="audit-workspace">
      <aside className="audit-list-panel">
        <form className="audit-search" onSubmit={(event) => { event.preventDefault(); void loadSessions(); }}>
          <Search size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户、标题或仓库" aria-label="搜索会话" />
          <button type="submit">搜索</button>
        </form>
        <div className="audit-list-heading">
          <span>{loading ? "加载中…" : `${sessions.length} 个结果`}</span>
          <button className="icon-button" onClick={() => void loadSessions()} aria-label="刷新"><RefreshCw size={14} /></button>
        </div>
        <div className="audit-session-list">
          {sessions.map((session) => <button key={session.id} className={`audit-session ${selectedId === session.id ? "active" : ""}`} onClick={() => setSelectedId(session.id)}>
            <div className="audit-user-line">
              {session.user.avatarUrl ? <img src={session.user.avatarUrl} alt="" /> : <span className="audit-avatar">{session.user.login.slice(0, 1).toUpperCase()}</span>}
              <strong>{session.user.displayName || session.user.login}</strong>
              <time>{formatDate(session.updatedAt)}</time>
            </div>
            <b>{session.title}</b>
            <p>{session.lastMessagePreview || "暂无消息"}</p>
            <small>{session.repositoryName} · {session.messageCount} 条消息</small>
          </button>)}
          {!loading && sessions.length === 0 && <p className="audit-empty">没有匹配的会话</p>}
        </div>
      </aside>

      <article className="audit-detail">
        {error && <div className="error-banner">{error}</div>}
        {!selectedId && !error && <div className="audit-placeholder"><MessageSquareText size={34} /><h2>选择一个会话</h2><p>左侧按最近更新时间列出了所有人的对话。</p></div>}
        {selectedId && !detail && !error && <div className="audit-placeholder"><p>正在加载完整对话…</p></div>}
        {detail && <>
          <header className="audit-detail-header">
            <div><p className="eyebrow">{detail.session.user.login}</p><h2>{detail.session.title}</h2></div>
            <div><span>{detail.session.repositoryName}</span><span>{detail.session.model}</span><span>{detail.session.messageCount} 条消息</span></div>
          </header>
          <div className="audit-messages">
            {conversationItems.map((item) => item.kind === "message"
              ? <div key={item.key} className="audit-message-wrap"><time>{formatDate(item.message.createdAt)}</time><Message message={item.message} /></div>
              : <div key={item.key} className="audit-tool-wrap"><time>{formatDate(item.messages[0]?.createdAt ?? detail.session.updatedAt)}</time><ToolActivityGroup messages={item.messages} /></div>)}
            {detail.messages.length === 0 && <p className="audit-empty">这个会话还没有消息</p>}
          </div>
        </>}
      </article>
    </section>
  </main>;
}
