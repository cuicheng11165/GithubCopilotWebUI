import { Github } from "lucide-react";
import { LoginProviders } from "../../components/login-providers";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="brand-mark"><Github size={27} /></div>
        <p className="eyebrow">COPILOT WORKSPACE</p>
        <h1>Codebase conversations,<br />without leaving your browser.</h1>
        <p className="login-copy">Sign in with an approved GitHub identity. Your own Copilot entitlement is used for every request.</p>
        {error && <div className="error-banner">Sign-in failed: {error.replaceAll("_", " ")}</div>}
        <LoginProviders />
        <p className="login-footnote">Access is restricted to configured organizations. Repository contents remain on this host.</p>
      </section>
    </main>
  );
}
