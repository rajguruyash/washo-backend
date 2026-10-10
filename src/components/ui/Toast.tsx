import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** A button on the toast ("Undo"): pressing it runs `onClick` and closes the toast. */
export interface ToastAction { label: string; onClick: () => void }

interface ToastItem {
  id: number;
  tone: 'ok' | 'error';
  text: string;
  action?: ToastAction;
}

const ToastContext = createContext<{ success: (t: string, action?: ToastAction) => void; error: (t: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const close = useCallback((id: number) => setItems((cur) => cur.filter((i) => i.id !== id)), []);
  const push = useCallback((tone: ToastItem['tone'], text: string, action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setItems((cur) => [...cur.slice(-2), { id, tone, text, action }]);
    setTimeout(() => setItems((cur) => cur.filter((i) => i.id !== id)), action ? 7000 : 4200); // a toast with a button stays a little longer
  }, []);

  const api = useMemo(() => ({ success: (t: string, action?: ToastAction) => push('ok', t, action), error: (t: string) => push('error', t) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[90] flex flex-col items-center gap-2 px-4" aria-live="polite">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.96 }}
              className="glass-strong pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl px-4 py-3 text-sm"
              role={t.tone === 'error' ? 'alert' : 'status'}
            >
              {t.tone === 'ok' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-ok" /> : <AlertCircle className="h-5 w-5 shrink-0 text-bad" />}
              <span className="min-w-0 flex-1">{t.text}</span>
              {t.action && <button type="button" onClick={() => { t.action!.onClick(); close(t.id); }} className="shrink-0 rounded-lg px-2 py-1 text-sm font-bold text-washo-300 hover:bg-white/10 hover:text-white">{t.action.label}</button>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
