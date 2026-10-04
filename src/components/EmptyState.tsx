import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { AvatarHead } from './brand/Avatar';

export function EmptyState({ title, text, action, icon }: { title: string; text?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="panel flex flex-col items-center px-6 py-12 text-center"
    >
      {icon ?? <AvatarHead className="h-20 w-20" />}
      <h3 className="mt-5 text-lg font-bold">{title}</h3>
      {text && <p className="mt-1.5 max-w-sm text-sm text-fog">{text}</p>}
      {action && <div className="mt-6">{action}</div>}
    </motion.div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 md:mb-8">
      <div>
        <h1 className="text-3xl font-extrabold md:text-4xl">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-xl text-sm text-fog md:text-base">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="panel flex flex-col items-center px-6 py-10 text-center" role="alert">
      <p className="font-semibold">Couldn't load this</p>
      <p className="mt-1 text-sm text-fog">{message ?? 'Please check your connection and try again.'}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-4 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/5">
          Try again
        </button>
      )}
    </div>
  );
}
