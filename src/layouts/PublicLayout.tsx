import { AnimatePresence, motion } from 'framer-motion';
import { Mail, MapPin, Menu, Phone, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router-dom';
import { Atmosphere } from '../components/brand/Atmosphere';
import { Logo } from '../components/brand/Logo';
import { ButtonLink } from '../components/ui/Button';
import { useAuth } from '../state/auth';

const links = [
  { to: '/#how', label: 'How it works' },
  { to: '/services', label: 'Services' },
  { to: '/#membership', label: 'Membership' },
];

export function PublicLayout() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  const cta = user ? (
    <ButtonLink to="/app" size="sm">Open app</ButtonLink>
  ) : (
    <ButtonLink to="/login" size="sm">Sign in</ButtonLink>
  );

  return (
    <>
      <Atmosphere />
      <header className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${scrolled || open ? 'border-b border-white/[0.08] bg-ink-950/75 backdrop-blur-xl' : 'border-b border-transparent'}`}>
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link to="/" aria-label="WASHO home"><Logo /></Link>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className="rounded-xl px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:bg-white/[0.06] hover:text-white">
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <a href="tel:8668890147" className="hidden items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-mist hover:text-white lg:inline-flex"><Phone className="h-4 w-4" /> 86688 90147</a>
            {cta}
            <button onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} className="grid h-10 w-10 place-items-center rounded-xl text-mist hover:bg-white/10 md:hidden">
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
        <AnimatePresence>
          {open && (
            <motion.nav initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden md:hidden" aria-label="Mobile">
              <div className="space-y-1 px-4 pb-5 pt-1">
                {links.map((l) => (
                  <Link key={l.to} to={l.to} className="block rounded-xl px-3 py-3 text-base font-medium text-mist hover:bg-white/[0.06] hover:text-white">{l.label}</Link>
                ))}
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      <main><Outlet /></main>

      <footer className="border-t border-white/[0.08] bg-ink-950/60">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr] lg:px-8">
          <div>
            <Logo showTagline />
            <p className="mt-4 max-w-xs text-sm text-fog">Doorstep car and bike washing, right inside your society parking. Currently serving Kharadi, Pune.</p>
          </div>
          <div>
            <h4 className="text-sm font-bold">Explore</h4>
            <ul className="mt-4 space-y-2.5 text-sm text-fog">
              {links.map((l) => <li key={l.to}><Link to={l.to} className="hover:text-white">{l.label}</Link></li>)}
              <li><Link to="/login" className="hover:text-white">Sign in</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-bold">Contact</h4>
            <ul className="mt-4 space-y-2.5 text-sm text-fog">
              <li className="flex items-center gap-2"><Phone className="h-4 w-4 text-washo-300" /><a href="tel:8668890147" className="hover:text-white">8668890147</a> / <a href="tel:9822911523" className="hover:text-white">9822911523</a></li>
              <li className="flex items-center gap-2"><Mail className="h-4 w-4 text-washo-300" /><a href="mailto:contact.washo@gmail.com" className="hover:text-white">contact.washo@gmail.com</a></li>
              <li className="flex items-center gap-2"><MapPin className="h-4 w-4 text-washo-300" /> Kharadi, Pune</li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/[0.06] py-5 text-center text-xs text-fog">© {new Date().getFullYear()} WASHO. All rights reserved.</div>
      </footer>
      <ScrollRestoration />
    </>
  );
}
