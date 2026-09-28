import React from "react";

/*
 * The one typed-confirmation field every risk-scaled confirmation renders:
 * label copy, matching rule, and input attributes stay identical wherever it
 * is used (the shared confirm dialog and the protected-connection dialog).
 */

/** Case-sensitive, end-trimmed equality: the single rule every typed-confirmation gate uses. */
export function typedConfirmationMatches(value: string, phrase: string): boolean {
  return value.trim() === phrase;
}

export interface TypedConfirmationFieldProps {
  /** The exact phrase the operator must type. */
  phrase: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}

/**
 * The labelled "Type X to confirm" field, so a screen reader announces exactly what to type. Its host
 * dialog decides initial focus when it opens, so the field never takes focus on its own.
 */
export function TypedConfirmationField({ phrase, value, onChange, disabled, inputRef }: TypedConfirmationFieldProps): React.ReactElement {
  return (
    <label className="typedConfirmation">
      {`Type ${phrase} to confirm`}
      <input
        ref={inputRef}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
