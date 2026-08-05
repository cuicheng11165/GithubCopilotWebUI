import { notFound } from "next/navigation";
import { AuditApp } from "../../components/audit-app";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const apiUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";
  let enabled = false;
  try {
    const response = await fetch(`${apiUrl}/api/audit/status`, { cache: "no-store" });
    if (response.ok) enabled = ((await response.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    // Treat an unavailable API the same as a disabled audit surface.
  }
  if (!enabled) notFound();
  return <AuditApp />;
}
