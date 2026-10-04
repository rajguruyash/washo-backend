import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  tone: 'ok' | 'error';
  text: string;
}

const ToastContext = createContext<{ success: (t: string) => void; error: (t: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((tone: ToastItem['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((cur) => [...cur.slice(-2), { id, tone, text }]);
    setTimeout(() => setItems((cur) => cur.filter((i) => i.id !== id)), 4200);
  }, []);

  const api = useMemo(() => ({ success: (t: string) => push('ok', t), error: (t: string) => push('error', t) }), [push]);

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
              {t.text}
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
