interface HeldForm {
  buffers: Map<string, Buffer>;
  expiresAt: number;
}

export class SecureFormVault {
  private readonly forms = new Map<string, HeldForm>();

  private sweep(now = Date.now()): void {
    for (const [formId, entry] of this.forms) {
      if (entry.expiresAt <= now) this.discard(formId);
    }
  }

  putStep(formId: string, stepId: string, values: Record<string, string>, expiresAtMs: number, now = Date.now()): void {
    this.sweep(now);
    if (expiresAtMs <= now) return;
    let entry = this.forms.get(formId);
    if (!entry) {
      entry = { buffers: new Map(), expiresAt: expiresAtMs };
      this.forms.set(formId, entry);
    }
    entry.expiresAt = expiresAtMs;
    const previous = entry.buffers.get(stepId);
    previous?.fill(0);
    entry.buffers.set(stepId, Buffer.from(JSON.stringify(values), "utf8"));
  }

  claimAll(formId: string, expectedStepIds: readonly string[], now = Date.now()): Map<string, Record<string, string>> | null {
    const entry = this.forms.get(formId);
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.discard(formId);
      return null;
    }
    if (expectedStepIds.some((stepId) => !entry.buffers.has(stepId))) return null;
    const claimed = new Map<string, Record<string, string>>();
    for (const stepId of expectedStepIds) {
      const buffer = entry.buffers.get(stepId);
      if (!buffer) return null;
      claimed.set(stepId, JSON.parse(buffer.toString("utf8")) as Record<string, string>);
      buffer.fill(0);
      entry.buffers.delete(stepId);
    }
    if (entry.buffers.size === 0) this.forms.delete(formId);
    return claimed;
  }

  claimStep(formId: string, stepId: string, now = Date.now()): Record<string, string> | null {
    const entry = this.forms.get(formId);
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.discard(formId);
      return null;
    }
    const buffer = entry.buffers.get(stepId);
    if (!buffer) return null;
    const values = JSON.parse(buffer.toString("utf8")) as Record<string, string>;
    buffer.fill(0);
    entry.buffers.delete(stepId);
    if (entry.buffers.size === 0) this.forms.delete(formId);
    return values;
  }

  discardStep(formId: string, stepId: string): void {
    const entry = this.forms.get(formId);
    if (!entry) return;
    const buffer = entry.buffers.get(stepId);
    buffer?.fill(0);
    entry.buffers.delete(stepId);
    if (entry.buffers.size === 0) this.forms.delete(formId);
  }

  discard(formId: string): void {
    const entry = this.forms.get(formId);
    if (!entry) return;
    for (const buffer of entry.buffers.values()) buffer.fill(0);
    entry.buffers.clear();
    this.forms.delete(formId);
  }

  discardMany(formIds: readonly string[]): number {
    let discarded = 0;
    for (const formId of formIds) {
      if (!this.forms.has(formId)) continue;
      this.discard(formId);
      discarded += 1;
    }
    return discarded;
  }

  has(formId: string, now = Date.now()): boolean {
    const entry = this.forms.get(formId);
    if (!entry) return false;
    if (entry.expiresAt <= now) {
      this.discard(formId);
      return false;
    }
    return true;
  }
}
