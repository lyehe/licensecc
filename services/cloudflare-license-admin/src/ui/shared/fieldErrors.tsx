import React, { useCallback, useEffect, useState } from "react";

import { TechnicalDetails } from "./FeedbackText";
import { describeCode, failureFeedback, ruleCodeField, unknownResultText } from "./messages";
import type { FeedbackDetail, OperatorFeedback } from "./operatorFeedback";

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
  /** The refusal behind a field's error, when a server request produced it. */
  details: Readonly<Record<string, FeedbackDetail>>;
  status: OperatorFeedback | null;
  /** Show a code beside its field (and focus it) or as the form's status; returns the field, if any. */
  show: (code: string, requestId: string | null, fieldFor: (code: string) => string | null) => string | null;
  /** Mark fields directly with a workflow's own sentence, keeping the refusal behind it if any. */
  showFields: (errors: FieldErrors, detail?: FeedbackDetail) => void;
  setStatus: (status: OperatorFeedback | null) => void;
  clearField: (field: string) => void;
  clear: () => void;
}

/**
 * One form's inline errors and status line. Both clear whenever `resetKey` changes: an error
 * describes the values it was shown for, not whatever the form holds next.
 */
export function useFormFeedback(form: string, resetKey: unknown): FormFeedback {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [details, setDetails] = useState<Readonly<Record<string, FeedbackDetail>>>({});
  const [status, setStatus] = useState<OperatorFeedback | null>(null);
  useEffect(() => { setErrors({}); setDetails({}); setStatus(null); }, [resetKey]);
  const show = useCallback((code: string, requestId: string | null, fieldFor: (code: string) => string | null): string | null => {
    // A field the form does not show right now (such as the add-on key of an included plan feature)
    // cannot carry the error; the form's status line does instead.
    const mapped = fieldFor(code);
    const field = mapped !== null && fieldElement(form, mapped) !== null ? mapped : null;
    if (field === null) {
      setErrors({});
      setDetails({});
      setStatus(failureFeedback(code, requestId));
      return null;
    }
    setErrors({ [field]: describeCode(code)?.text ?? unknownResultText(requestId) });
    // Only a server refusal has a request to name; a local rule's code needs no Technical details.
    setDetails(requestId === null ? {} : { [field]: { code, requestId } });
    setStatus(null);
    focusField(form, field);
    return field;
  }, [form]);
  const showFields = useCallback((next: FieldErrors, detail?: FeedbackDetail): void => {
    setErrors(next);
    setDetails(detail === undefined ? {} : Object.fromEntries(Object.keys(next).map((field) => [field, detail])));
    setStatus(null);
    const first = Object.keys(next)[0];
    if (first !== undefined) focusField(form, first);
  }, [form]);
  const clearField = useCallback((field: string): void => {
    const without = <T,>(current: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
      if (!Object.hasOwn(current, field)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    };
    setErrors(without);
    setDetails(without);
  }, []);
  const clear = useCallback((): void => { setErrors({}); setDetails({}); setStatus(null); }, []);
  return { errors, details, status, show, showFields, setStatus, clearField, clear };
}

/**
 * The refusal behind a field's error, under Technical details. It follows the field's label as its
 * own grid item, since a disclosure cannot sit inside a label; the input names only the error.
 */
export function FieldDetails({ field, feedback }: { field: string; feedback: FormFeedback }): React.ReactElement | null {
  return <TechnicalDetails detail={feedback.details[field]} />;
}
