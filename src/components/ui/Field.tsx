import { AlertCircle } from 'lucide-react';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const control =
  'w-full rounded-2xl border border-white/[0.1] bg-white/[0.04] px-4 text-white placeholder:text-fog/60 transition-colors focus:border-washo-400 focus:bg-white/[0.07] focus:outline-none focus:ring-4 focus:ring-washo-500/15 disabled:opacity-50';

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  className?: string;
}

function Shell({ label, hint, error, optional, className, htmlFor, children, describedBy }: FieldShellProps & { htmlFor: string; children: ReactNode; describedBy: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between text-[13px] font-medium text-mist">
        <span>{label}</span>
        {optional && <span className="text-xs font-normal text-fog">Optional</span>}
      </label>
      {children}
      <div id={describedBy} aria-live="polite">
        {error ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-bad">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> {error}
          </p>
        ) : hint ? (
          <p className="mt-1.5 text-xs text-fog">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, FieldShellProps & InputHTMLAttributes<HTMLInputElement>>(function Input(
  { label, hint, error, optional, className, ...rest },
  ref
) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} optional={optional} className={className} htmlFor={id} describedBy={`${id}-d`}>
      <input
        ref={ref}
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-d`}
        className={cn(control, 'h-12', error && 'border-bad/60 focus:border-bad focus:ring-bad/15')}
        {...rest}
      />
    </Shell>
  );
});

export function Select({
  label,
  hint,
  error,
  optional,
  className,
  children,
  ...rest
}: FieldShellProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} optional={optional} className={className} htmlFor={id} describedBy={`${id}-d`}>
      <select id={id} className={cn(control, 'h-12 appearance-none', error && 'border-bad/60')} {...rest}>
        {children}
      </select>
    </Shell>
  );
}

export function TextArea({
  label,
  hint,
  error,
  optional,
  className,
  ...rest
}: FieldShellProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Shell label={label} hint={hint} error={error} optional={optional} className={className} htmlFor={id} describedBy={`${id}-d`}>
      <textarea id={id} rows={3} className={cn(control, 'resize-none py-3', error && 'border-bad/60')} {...rest} />
    </Shell>
  );
}
