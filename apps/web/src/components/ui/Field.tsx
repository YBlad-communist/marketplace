'use client';

import { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, forwardRef, useId } from 'react';
import { cn } from '@/lib/format';

interface FieldWrapProps {
  label?: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}

export function FieldWrap({ label, htmlFor, error, hint, required, children }: FieldWrapProps) {
  return (
    <div>
      {label && (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {required ? ' *' : ''}
        </label>
      )}
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, id, required, className, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <FieldWrap label={label} htmlFor={inputId} error={error} hint={hint} required={required}>
      <input ref={ref} id={inputId} className={cn('input', error && 'input-error', className)} {...rest} />
    </FieldWrap>
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, id, required, className, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <FieldWrap label={label} htmlFor={inputId} error={error} hint={hint} required={required}>
      <textarea ref={ref} id={inputId} className={cn('input', error && 'input-error', className)} {...rest} />
    </FieldWrap>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, id, required, className, children, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <FieldWrap label={label} htmlFor={inputId} error={error} hint={hint} required={required}>
      <select ref={ref} id={inputId} className={cn('input', error && 'input-error', className)} {...rest}>
        {children}
      </select>
    </FieldWrap>
  );
});

interface CheckProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckProps>(function Checkbox({ label, id, className, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label htmlFor={inputId} className="flex cursor-pointer items-center gap-2 text-sm text-textPrimary">
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className={cn('h-4 w-4 rounded accent-accent', className)}
        {...rest}
      />
      {label}
    </label>
  );
});

export const Radio = forwardRef<HTMLInputElement, CheckProps>(function Radio({ label, id, className, ...rest }, ref) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label htmlFor={inputId} className="flex cursor-pointer items-center gap-2 text-sm text-textPrimary">
      <input ref={ref} id={inputId} type="radio" className={cn('h-4 w-4 accent-accent', className)} {...rest} />
      {label}
    </label>
  );
});
