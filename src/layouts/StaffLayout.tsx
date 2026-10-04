import { motion } from 'framer-motion';
import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Outlet, ScrollRestoration } from 'react-router-dom';
import { Atmosphere } from '../components/brand/Atmosphere';
import { Logo } from '../components/brand/Logo';
import { Badge } from '../components/ui/Badge';
import type { Role } from '../lib/types';
import { useAuth } from '../state/auth';
import { RequireRole } from './AppLayout';

/** Shared shell for the specialist's and WASHO admin's consoles. */
export function StaffLayout({ role, title, children }: { role: Exclude<Role, 'customer'>; title: string; children?: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <RequireRole role={role}>
      <Atmosphere />
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
