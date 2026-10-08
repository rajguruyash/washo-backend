import { motion } from 'framer-motion';
import { LogOut } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, Outlet, ScrollRestoration } from 'react-router-dom';
import { Logo } from '../components/brand/Logo';
import { Badge } from '../components/ui/Badge';
import { post } from '../lib/http';
import type { Role } from '../lib/types';
import { useAuth } from '../state/auth';
import { RequireRole } from './AppLayout';

/**
 * An admin who walks away is signed out: after `minutes` without touching the page this signs them out and says why. (The server enforces the same limit on every
 * request, so a page left open cannot keep a session alive; this just makes it visible and immediate.)
 */
function useIdleSignOut(minutes: number | null) {
  const last = useRef(Date.now());
  useEffect(() => {
    if (!minutes) return;
    last.current = Date.now();
    const touch = () => { last.current = Date.now(); };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'visibilitychange'] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - last.current < minutes * 60_000) return;
      window.clearInterval(timer);
      void post('/auth/logout').catch(() => undefined).finally(() => window.location.assign('/login?mode=email&reason=idle'));
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      window.clearInterval(timer);
    };
  }, [minutes]);
}

/** Shared shell for the specialist's and WASHO admin's consoles. */
export function StaffLayout({ role, title, children }: { role: Exclude<Role, 'customer'>; title: string; children?: ReactNode }) {
  const { user, logout } = useAuth();
  useIdleSignOut(role === 'admin' && user ? (user.admin?.idle_minutes ?? 30) : null);
  return (
    <RequireRole role={role}>
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-ink-950/80 backdrop-blur-xl">
        <div className={`mx-auto flex h-14 items-center justify-between px-4 sm:px-6 ${role === 'admin' ? 'max-w-7xl' : 'max-w-3xl'}`}>
          <div className="flex items-center gap-3">
            <Link to={role === 'admin' ? '/admin' : '/worker'}><Logo /></Link>
            <Badge tone="blue">{title}</Badge>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-fog sm:block">{user?.full_name}</span>
            <button onClick={() => void logout()} aria-label="Sign out" className="grid h-9 w-9 place-items-center rounded-xl text-fog hover:bg-white/10 hover:text-white"><LogOut className="h-4 w-4" /></button>
          </div>
        </div>
      </header>
      <main className={`mx-auto w-full px-4 pb-24 pt-5 sm:px-6 md:pt-8 ${role === 'admin' ? 'max-w-7xl' : 'max-w-3xl'}`}>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
          {children ?? <Outlet />}
        </motion.div>
      </main>
      <ScrollRestoration />
    </RequireRole>
  );
}
