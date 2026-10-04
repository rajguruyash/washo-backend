import { motion } from 'framer-motion';
import { BadgeCheck, CalendarDays, Car, ClipboardList, Home, LogOut, Plus, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, ScrollRestoration, useLocation } from 'react-router-dom';
import { AvatarHead } from '../components/brand/Avatar';
import { Atmosphere } from '../components/brand/Atmosphere';
import { Logo } from '../components/brand/Logo';
import { Skeleton } from '../components/ui/Skeleton';
import { cn } from '../lib/cn';
import type { Role } from '../lib/types';
import { useAuth } from '../state/auth';

const homeFor = (role: Role) => (role === 'admin' ? '/admin' : role === 'worker' ? '/worker' : '/app');

/** Signed-in, with the right role. Staff who open the customer app are sent to their own console, and vice versa. */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { user, loading } = useAuth();
  const { pathname, search } = useLocation();
  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Atmosphere />
        <Logo className="animate-pulse" />
      </div>
    );
  }
  if (!user) {
    const next = `next=${encodeURIComponent(pathname + search)}`;
    return <Navigate to={role === 'customer' ? `/login?${next}` : `/login?staff=1&${next}`} replace />;
  }
  if (user.role !== role) return <Navigate to={homeFor(user.role)} replace />;
  if (role === 'customer' && user.needs_profile && pathname !== '/app/welcome') return <Navigate to="/app/welcome" replace />;
  return <>{children}</>;
}

const nav = [
  { to: '/app', label: 'Home', icon: Home, end: true },
  { to: '/app/membership', label: 'Membership', icon: BadgeCheck },
  { to: '/app/bookings', label: 'Bookings', icon: ClipboardList },
  { to: '/app/book', label: 'Single wash', icon: CalendarDays },
  { to: '/app/vehicles', label: 'Vehicles', icon: Car },
];

function SideLink({ to, label, end, Icon }: { to: string; label: string; end?: boolean; Icon: typeof Home }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cn('relative flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition-colors', isActive ? 'text-white' : 'text-fog hover:bg-white/[0.04] hover:text-white')}>
      {({ isActive }) => (
        <>
          {isActive && <motion.span layoutId="side-active" className="absolute inset-0 rounded-2xl border border-white/[0.1] bg-white/[0.07]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          <Icon className={cn('relative h-[18px] w-[18px]', isActive && 'text-washo-300')} />
          <span className="relative">{label}</span>
        </>
      )}
    </NavLink>
  );
}

function Sidebar() {
  const { user, logout } = useAuth();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[17rem] flex-col border-r border-white/[0.07] bg-ink-950/60 p-5 backdrop-blur-xl lg:flex">
      <Link to="/app" className="px-2 pt-1"><Logo /></Link>
      <nav className="mt-8 flex flex-1 flex-col gap-1" aria-label="App">
        {nav.map((n) => (
          <SideLink key={n.to} to={n.to} label={n.label} end={n.end} Icon={n.icon} />
        ))}
      </nav>
      <Link to="/app/membership/new" className="glass mb-4 block p-4 transition-colors hover:border-washo-400/40">
        <p className="eyebrow">Membership</p>
        <p className="mt-1 text-sm font-semibold">Start a custom plan</p>
        <p className="text-xs text-fog">1, 2 or 3 washes a week</p>
      </Link>
      <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] p-3">
        <AvatarHead className="h-10 w-10" ring={false} />
        <Link to="/app/account" className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{user?.full_name}</p>
          <p className="truncate text-xs text-fog">{user?.phone}</p>
        </Link>
        <button onClick={() => void logout()} aria-label="Sign out" className="grid h-9 w-9 place-items-center rounded-xl text-fog hover:bg-white/10 hover:text-white"><LogOut className="h-4 w-4" /></button>
      </div>
    </aside>
  );
}

function BottomBar() {
  const item = (to: string, label: string, Icon: typeof Home, end?: boolean) => (
    <NavLink key={to} to={to} end={end} className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-semibold transition-colors', isActive ? 'text-white' : 'text-fog')}>
      {({ isActive }) => (
        <>
          <span className="relative grid h-8 w-12 place-items-center">
            {isActive && <motion.span layoutId="tab-active" className="absolute inset-0 rounded-full bg-washo-500/20" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
            <Icon className={cn('relative h-[21px] w-[21px]', isActive && 'text-washo-300')} />
          </span>
          {label}
        </>
      )}
    </NavLink>
  );
  return (
    <nav aria-label="App" className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-ink-900/85 backdrop-blur-xl lg:hidden">
      <div className="mx-auto flex max-w-lg items-end px-2">
        {item('/app', 'Home', Home, true)}
        {item('/app/membership', 'Plans', BadgeCheck)}
        <div className="flex flex-1 justify-center">
          <Link to="/app/membership/new" aria-label="Start a membership" className="-mt-5 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-b from-washo-400 to-washo-700 text-white shadow-[0_10px_30px_-6px_rgb(42_98_230/0.9),inset_0_1px_0_rgb(255_255_255/0.3)] ring-4 ring-ink-950 transition-transform active:scale-90">
            <Plus className="h-7 w-7" strokeWidth={2.5} />
          </Link>
        </div>
        {item('/app/bookings', 'Washes', ClipboardList)}
        {item('/app/account', 'Account', UserRound)}
      </div>
    </nav>
  );
}

export function AppLayout() {
  const { pathname } = useLocation();
  const focused = pathname === '/app/welcome';
  // Wizards own the bottom of the screen with their own sticky action bar.
  const immersive = /^\/app\/(book|membership\/new)\/?$/.test(pathname);
  return (
    <RequireRole role="customer">
      <Atmosphere />
      {!focused && <Sidebar />}
      <div className={cn(!focused && 'lg:pl-[17rem]')}>
        {!focused && (
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/[0.07] bg-ink-950/75 px-4 backdrop-blur-xl lg:hidden">
            <Link to="/app"><Logo /></Link>
            <Link to="/app/account" aria-label="Account"><AvatarHead className="h-9 w-9" ring={false} /></Link>
          </header>
        )}
        <main className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-10', focused ? 'py-8' : 'pb-32 pt-6 md:pt-10 lg:pb-16')}>
          {/* Opacity only: a transform here would become the containing block for the wizards' fixed action bars. */}
          <motion.div key={pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
            <Outlet />
          </motion.div>
        </main>
      </div>
      {!focused && !immersive && <BottomBar />}
      <ScrollRestoration />
    </RequireRole>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-1/3" />
      <Skeleton className="h-40" />
      <Skeleton className="h-40" />
    </div>
  );
}
