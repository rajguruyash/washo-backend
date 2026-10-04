import { Link } from 'react-router-dom';
import { AvatarHead } from '../components/brand/Avatar';
import { ButtonLink } from '../components/ui/Button';

export default function NotFound() {
  return (
    <div className="grid min-h-[70dvh] place-items-center px-4 pt-20 text-center">
      <div>
        <AvatarHead className="mx-auto h-24 w-24" />
        <p className="mt-6 font-display text-6xl font-extrabold text-gradient">404</p>
        <h1 className="mt-2 text-2xl font-bold">We couldn't find that page</h1>
        <p className="mt-2 text-fog">It may have moved, or the link might be mistyped.</p>
        <div className="mt-7 flex justify-center gap-3"><ButtonLink to="/">Go home</ButtonLink><Link to="/app" className="inline-flex h-11 items-center rounded-2xl px-5 text-sm font-semibold text-mist hover:bg-white/[0.06]">Open app</Link></div>
      </div>
    </div>
  );
}
