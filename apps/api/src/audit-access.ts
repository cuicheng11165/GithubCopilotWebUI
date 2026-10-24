export type AuditAccess =
  | { status: 200 }
  | { status: 401 | 403 | 404; error: string };

export function auditSessionsAccess(input: {
  enabled: boolean;
  login: string | null;
  isAdmin: boolean;
}): AuditAccess {
  if (!input.enabled) return { status: 404, error: "Audit page is disabled" };
  if (!input.login) return { status: 401, error: "Authentication required" };
  if (!input.isAdmin) return { status: 403, error: "Audit access requires a configured administrator" };
  return { status: 200 };
}
