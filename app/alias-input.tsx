"use client";
import { useState } from "react";

export function parseAliases(value: string) {
  return [...new Set(value.split(/[،,\n]/).map(item => item.trim()).filter(Boolean))];
}

/** Keep the exact editing buffer (including a trailing delimiter) while focused.
 * Parent settings still receive parsed aliases on every keystroke, so Save is safe. */
export function AliasInput({ values, onChange, placeholder }: { values: string[]; onChange: (values: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <input value={draft ?? values.join("، ")} placeholder={placeholder}
    onFocus={event => setDraft(event.target.value)}
    onChange={event => { setDraft(event.target.value); onChange(parseAliases(event.target.value)); }}
    onBlur={() => setDraft(null)} />;
}
