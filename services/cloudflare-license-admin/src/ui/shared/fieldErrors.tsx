import React, { useCallback, useEffect, useState } from "react";

import { describeCode, failureFeedback, ruleCodeField, unknownResultText } from "./messages";
import type { OperatorFeedback } from "./operatorFeedback";

/*
 * Inline validation: a code that belongs to one field shows beside that field, which names it
 * through aria-describedby and is marked aria-invalid; any other code stays in the form's own
 * status line. One failure has one surface, so neither is repeated in the page banner.
 */

export type FieldErrors = Readonly<Record<string, string>>;

export function fieldErrorId(form: string, field: string): string {
  return `${form}-${field}-error`;
}

/**
 * The field a code belongs to in one form: an exact code first, then a family rule naming one of
 * the fields this form shows. Anything else, including a rule for a field the form does not show,
 * is null and stays with the whole form.
 */
export function fieldForCode(code: string, fields: readonly string[], exact: Readonly<Record<string, string>> = {}): string | null {
  if (Object.hasOwn(exact, code)) return exact[code];
  const field = ruleCodeField(code);
  return field !== null && fields.includes(field) ? field : null;
}

/**
 * Props that tie an input to its inline error. The error sits inside the input's label, so `label`
 * names the input explicitly and the error text never becomes part of its name; `describedBy`
 * keeps any help text the input already names.
 */
export function fieldProps(form: string, errors: FieldErrors, field: string, label?: string, describedBy?: string): { name: string; "aria-label"?: string; "aria-invalid"?: true; "aria-describedby"?: string } {
  const invalid = Object.hasOwn(errors, field);
  const ids = [describedBy, invalid ? fieldErrorId(form, field) : undefined].filter((id) => id !== undefined).join(" ");
  return { name: field, ...(label === undefined ? {} : { "aria-label": label }), ...(invalid ? { "aria-invalid": true as const } : {}), ...(ids === "" ? {} : { "aria-describedby": ids }) };
}

export function FieldError({ form, field, errors }: { form: string; field: string; errors: FieldErrors }): React.ReactElement | null {
  return Object.hasOwn(errors, field) ? <span className="fieldError" id={fieldErrorId(form, field)} role="alert">{errors[field]}</span> : null;
}

function fieldElement(form: string, field: string): HTMLElement | null {
  return document.getElementById(form)?.querySelector<HTMLElement>(`[name="${field}"], [data-field="${field}"]`) ?? null;
}

/** Focus a field (or a named group of fields), opening a collapsed section such as advanced settings. */
function focusField(form: string, field: string): void {
  const input = fieldElement(form, field);
  const disclosure = input?.closest("details");
  if (disclosure) disclosure.open = true;
  input?.focus();
}

export interface FormFeedback {
  errors: FieldErrors;
  status: OperatorFeedback | null;
  /** Show a code beside its field (and focus it) or as the form's status; returns the field, if any. */
  show: (code: string, requestId: string | null, fieldFor: (code: string) => string | null) => string | null;
  /** Mark fields directly, such as number inputs the browser could not read. */
  showFields: (errors: FieldErrors) => void;
  setStatus: (status: OperatorFeedback | null) => void;
  clearField: (field: string) => void;
  clear: () => void;
}

/** One form's inline errors and status line. The status clears whenever `resetKey` changes. */
export function useFormFeedback(form: string, resetKey: unknown): FormFeedback {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<OperatorFeedback | null>(null);
  useEffect(() => { setStatus(null); }, [resetKey]);
  const show = useCallback((code: string, requestId: string | null, fieldFor: (code: string) => string | null): string | null => {
    // A field the form does not show right now (such as a device-locked policy's seat pool) cannot
    // carry the error; the form's status line does instead.
    const mapped = fieldFor(code);
    const field = mapped !== null && fieldElement(form, mapped) !== null ? mapped : null;
    if (field === null) {
      setErrors({});
      setStatus(failureFeedback(code, requestId));
      return null;
    }
    setErrors({ [field]: describeCode(code)?.text ?? unknownResultText(requestId) });
    setStatus(null);
    focusField(form, field);
    return field;
  }, [form]);
  const showFields = useCallback((next: FieldErrors): void => {
    setErrors(next);
    setStatus(null);
    const first = Object.keys(next)[0];
    if (first !== undefined) focusField(form, first);
  }, [form]);
  const clearField = useCallback((field: string): void => {
    setErrors((current) => {
      if (!Object.hasOwn(current, field)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);
  const clear = useCallback((): void => { setErrors({}); setStatus(null); }, []);
  return { errors, status, show, showFields, setStatus, clearField, clear };
}

/** Tracks number inputs whose text the browser could not read (`validity.badInput`), by field name. */
export function useUnreadableNumbers(): { unreadable: ReadonlySet<string>; track: (field: string, event: React.ChangeEvent<HTMLInputElement>) => void; reset: () => void } {
  const [unreadable, setUnreadable] = useState<ReadonlySet<string>>(new Set());
  const track = useCallback((field: string, event: React.ChangeEvent<HTMLInputElement>): void => {
    const bad = event.target.validity.badInput;
    setUnreadable((current) => {
      if (current.has(field) === bad) return current;
      const next = new Set(current);
      if (bad) next.add(field);
      else next.delete(field);
      return next;
    });
  }, []);
  const reset = useCallback((): void => setUnreadable(new Set()), []);
  return { unreadable, track, reset };
}
