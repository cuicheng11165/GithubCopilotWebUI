import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { visibleSecureFormCards, type SecureFormSnapshot } from "@app/contracts";
import { advanceSecureFormCard, SecureFormCard, SecureFormModal } from "./secure-form-card.js";

const form: SecureFormSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
  title: "Sign in to Microsoft (SharePoint Guild)",
  subtitle: "Secure form",
  targetSite: "login.microsoftonline.com",
  purpose: "Open SharePoint",
  steps: [
    { id: "account", kind: "input", fields: [{ name: "email", label: "Email", type: "email", required: true }] },
    { id: "secret", kind: "input", fields: [{ name: "password", label: "Password", type: "password", required: true }] }
  ],
  currentStep: 0,
  status: "pending",
  expiresAt: "2099-01-01T00:00:00.000Z"
};

describe("secure form card", () => {
  it("shows an Open card and a masked password field in the modal", () => {
    const [openCard] = visibleSecureFormCards(form);
    if (!openCard) throw new Error("missing card");
    const open = renderToStaticMarkup(createElement(SecureFormCard, { card: openCard, csrfToken: "csrf", onAdvance() {}, onCancel() {} }));
    expect(open).toContain("Sign in to Microsoft (SharePoint Guild)");
    expect(open).toContain("Opens a secure form");
    expect(open).toContain("Open");
    expect(open).not.toContain("type=\"password\"");

    const submittedForm: SecureFormSnapshot = { ...form, currentStep: 1, status: "pending" };
    const [submitted] = visibleSecureFormCards(submittedForm);
    if (!submitted) throw new Error("missing submitted card");
    const submittedMarkup = renderToStaticMarkup(createElement(SecureFormCard, { card: submitted, csrfToken: "csrf", onAdvance() {}, onCancel() {} }));
    expect(submittedMarkup).toContain("Secure form");
    expect(submittedMarkup).toContain("Submitted");

    const passwordCard = visibleSecureFormCards(submittedForm)[1];
    if (!passwordCard) throw new Error("missing password card");
    const modal = renderToStaticMarkup(createElement(SecureFormModal, { card: passwordCard, csrfToken: "csrf", onClose() {}, onAdvance() {}, onCancel() {} }));
    expect(modal).toContain("type=\"password\"");
    expect(modal).toContain("The assistant only learns");
    expect(modal).not.toContain("hunter2");
  });

  it("reveals the next step after a successful submit", () => {
    const [card] = visibleSecureFormCards(form);
    if (!card) throw new Error("missing card");
    const next = advanceSecureFormCard([form], card);
    expect(next[0]?.currentStep).toBe(1);
    expect(next[0]?.status).toBe("pending");
    expect(visibleSecureFormCards(next[0]!).map((item) => item.state)).toEqual(["submitted", "open"]);
  });
});