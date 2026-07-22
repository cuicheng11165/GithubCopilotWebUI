"use client";

import { useEffect, useState } from "react";
import { Github, ShieldCheck } from "lucide-react";

export function LoginProviders() {
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => { void fetch("/api/auth/providers").then((response) => response.json()).then(setProviders); }, []);
  return <div className="login-actions">{providers.map((provider) => <a className="button primary wide" href={`/api/auth/${provider.id}/login`} key={provider.id}>{provider.id === "github" ? <Github size={18} /> : <ShieldCheck size={18} />} Continue with {provider.label}</a>)}</div>;
}
