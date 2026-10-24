import { describe, expect, it } from "vitest";
import { auditSessionsAccess } from "./audit-access.js";

describe("audit session access", () => {
  it("hides the endpoints until audit is enabled", () => {
    expect(auditSessionsAccess({ enabled: false, login: "octocat", isAdmin: true })).toEqual({
      status: 404,
      error: "Audit page is disabled"
    });
  });

  it("requires an authenticated admin from the allowlist", () => {
    expect(auditSessionsAccess({ enabled: true, login: null, isAdmin: false })).toEqual({
      status: 401,
      error: "Authentication required"
    });
    expect(auditSessionsAccess({ enabled: true, login: "octocat", isAdmin: false })).toEqual({
      status: 403,
      error: "Audit access requires a configured administrator"
    });
    expect(auditSessionsAccess({ enabled: true, login: "octocat", isAdmin: true })).toEqual({ status: 200 });
  });
});
