import type { SupportPicture } from '../lib/types';

/** The pictures sent with one message of a complaint. Tap one to open it full size in a new tab. */
export function SupportPictures({ pictures }: { pictures?: SupportPicture[] }) {
  const shown = (pictures ?? []).filter((p) => p.url);
  if (!shown.length) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-2" aria-label="Pictures">
      {shown.map((p, i) => (
        <li key={p.id}>
          <a href={p.url!} target="_blank" rel="noopener noreferrer" aria-label={`Open picture ${i + 1} full size`} className="block overflow-hidden rounded-xl border border-white/10 transition-colors hover:border-washo-400/60">
            <img src={p.url!} alt={`Picture ${i + 1}`} loading="lazy" className="h-24 w-24 object-cover sm:h-28 sm:w-28" />
          </a>
        </li>
      ))}
    </ul>
  );
}
