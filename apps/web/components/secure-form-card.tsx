"use client";

import { useEffect, useId, useState } from "react";
import { Check, Lock } from "lucide-react";
import type { SecureFormCardModel, SecureFormField, SecureFormSnapshot } from "@app/contracts";
import { apiWrite } from "../lib/api";

export function SecureFormCard({ card, csrfToken, onAdvance, onCancel }: {
  card: SecureFormCardModel;
  csrfToken: string;
  onAdvance: (card: SecureFormCardModel) => void;
  onCancel: (card: SecureFormCardModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const subtitle = card.state === "open" ? "Opens a secure form" : "Secure form";
  return <>
    <article className="secure-form-card">
      <div className="secure-form-icon" aria-hidden="true"><Lock size={16} /></div>
      <div className="secure-form-copy">
        <strong>{card.form.title}</strong>
        <small>{subtitle}</small>
      </div>
      {card.state === "open" ? <button type="button" className="secure-form-open" onClick={() => setOpen(true)}>Open</button> : null}
      {card.state === "submitted" ? <span className="secure-form-submitted"><Check size={16} /> Submitted</span> : null}
      {card.state === "cancelled" ? <span className="secure-form-terminal">Cancelled</span> : null}
      {card.state === "expired" ? <span className="secure-form-terminal">Expired</span> : null}
    </article>
    {open ? <SecureFormModal card={card} csrfToken={csrfToken} onClose={() => setOpen(false)} onAdvance={() => { setOpen(false); onAdvance(card); }} onCancel={() => { setOpen(false); onCancel(card); }} /> : null}
  </>;
}

export function SecureFormModal({ card, csrfToken, onClose, onAdvance, onCancel }: {
  card: SecureFormCardModel;
  csrfToken: string;
  onClose: () => void;
  onAdvance: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const submit = async (body: { stepId: string; confirmed?: boolean; values?: Record<string, string> }) => {
    setPending(true);
    setError(null);
    try {
      await apiWrite(`/api/sessions/${card.form.sessionId}/secure-forms/${card.form.id}/submit`, csrfToken, "POST", body);
      onAdvance();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Secure form could not be submitted");
      setPending(false);
    }
  };
  const cancel = async () => {
    setPending(true);
    try {
      await apiWrite(`/api/sessions/${card.form.sessionId}/secure-forms/${card.form.id}/cancel`, csrfToken, "POST", {});
      onCancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Secure form could not be cancelled");
      setPending(false);
    }
  };
  return <div className="secure-form-backdrop" onMouseDown={onClose}>
    <form className="secure-form-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
      event.preventDefault();
      if (card.step.kind === "confirm") void submit({ stepId: card.step.id, confirmed: true });
      else void submit({ stepId: card.step.id, values });
    }}>
      <p className="eyebrow">SECURE FORM</p>
      <h2 id={titleId}>{card.step.title ?? card.form.title}</h2>
      <p className="secure-form-target">{card.form.targetSite}</p>
      <p>{card.step.prompt ?? card.form.purpose}</p>
      <p className="secure-form-progress">Step {card.stepIndex + 1} of {card.form.steps.length}</p>
      {card.step.kind === "input" ? card.step.fields.map((field) => <SecureFormFieldInput key={field.name} field={field} value={values[field.name] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} />) : <p>Approve on your phone, then continue. This step does not collect a code.</p>}
      <p className="secure-form-note">The assistant only learns whether this step was submitted or cancelled.</p>
      {error ? <p className="secure-form-error" role="alert">{error}</p> : null}
      <div className="secure-form-actions">
        <button type="button" className="button secondary small" disabled={pending} onClick={() => void cancel()}>Cancel</button>
        <button type="submit" className="button primary small" disabled={pending}>{card.step.kind === "confirm" ? "Continue" : "Submit"}</button>
      </div>
    </form>
  </div>;
}

function SecureFormFieldInput({ field, value, onChange }: { field: SecureFormField; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const secret = field.type === "password" || field.type === "otp";
  return <label className="secure-form-field" htmlFor={id}>
    <span>{field.label}</span>
    <input
      id={id}
      value={value}
      required={field.required}
      type={field.type === "email" ? "email" : secret ? "password" : "text"}
      {...(field.type === "otp" ? { inputMode: "numeric" as const, autoComplete: "one-time-code" } : { autoComplete: field.type === "email" ? "username" : secret ? "current-password" : "off" })}
      onChange={(event) => onChange(event.target.value)}
    />
    {field.purpose ? <small>{field.purpose}</small> : null}
  </label>;
}

export function advanceSecureFormCard(forms: readonly SecureFormSnapshot[], card: SecureFormCardModel): SecureFormSnapshot[] {
  return forms.map((form) => {
    if (form.id !== card.form.id) return form;
    const currentStep = card.stepIndex + 1;
    const status = currentStep >= form.steps.length ? "submitted" : "pending";
    return { ...form, currentStep, status };
  });
}
