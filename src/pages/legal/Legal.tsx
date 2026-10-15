import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { LEGAL, POLICY_LINKS } from './facts';

export interface Section { id: string; title: string }

/** One policy page: a title, the date it was last changed, a short intro, a list of its sections, then the sections themselves. */
export function LegalPage({ title, intro, sections, children }: { title: string; intro: ReactNode; sections: Section[]; children: ReactNode }) {
  useEffect(() => {
    const before = document.title;
    document.title = `${title} | WASHO`;
    return () => { document.title = before; };
  }, [title]);
  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-32 sm:px-6">
      <p className="eyebrow">WASHO policies</p>
      <h1 className="mt-2 text-4xl font-extrabold leading-tight sm:text-5xl">{title}</h1>
      <p className="mt-3 text-sm text-fog">Last updated {LEGAL.updated}</p>
      <div className="mt-6 space-y-3 text-base text-mist">{intro}</div>

      <nav aria-label="On this page" className="glass mt-8 p-5">
        <p className="eyebrow">On this page</p>
        <ol className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          {sections.map((s, i) => (
            <li key={s.id}><a href={`#${s.id}`} className="text-washo-300 hover:text-white">{i + 1}. {s.title}</a></li>
          ))}
        </ol>
      </nav>

      <div className="mt-10 space-y-10">{children}</div>

      <div className="mt-14 border-t border-white/[0.08] pt-6">
        <p className="eyebrow">More policies</p>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {POLICY_LINKS.map((l) => <li key={l.to}><Link to={l.to} className="font-semibold text-washo-300 hover:text-white">{l.label}</Link></li>)}
        </ul>
      </div>
    </div>
  );
}

export function PolicySection({ id, title, n, children }: { id: string; title: string; n: number; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-28">
      <h2 id={`${id}-h`} className="text-2xl font-extrabold">{n}. {title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-mist">{children}</div>
    </section>
  );
}

export const Ul = ({ children }: { children: ReactNode }) => <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
export const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-white">{children}</strong>;

/** A small table that stacks on a phone: a label column and what it says. */
export function Rows({ rows, head }: { rows: [string, ReactNode][]; head?: [string, string] }) {
  return (
    <div className="panel overflow-hidden" role="table">
      {head && (
        <div role="row" className="hidden grid-cols-[11rem_1fr] gap-4 border-b border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-fog sm:grid">
          <span role="columnheader">{head[0]}</span><span role="columnheader">{head[1]}</span>
        </div>
      )}
      {rows.map(([k, v], i) => (
        <div key={k} role="row" className={cn('grid gap-1 px-4 py-3 text-sm sm:grid-cols-[11rem_1fr] sm:gap-4', i > 0 && 'border-t border-white/[0.06]')}>
          <span role="rowheader" className="font-semibold text-white">{k}</span>
          <span role="cell">{v}</span>
        </div>
      ))}
    </div>
  );
}

export const Contact = () => (
  <p>
    <a href={`mailto:${LEGAL.email}`} className="font-semibold text-washo-300 hover:text-white">{LEGAL.email}</a>, or call{' '}
    {LEGAL.phones.map((p, i) => <span key={p}>{i > 0 && ' / '}<a href={`tel:${p}`} className="font-semibold text-washo-300 hover:text-white">{p}</a></span>)}.
  </p>
);
