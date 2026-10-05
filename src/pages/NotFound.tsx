import { Link } from 'react-router-dom';
import { AvatarHead } from '../components/brand/Avatar';
import SplitFlapText from '../components/reactbits/SplitFlapText';
import { ButtonLink } from '../components/ui/Button';

export default function NotFound() {
  return (
    <div className="grid min-h-[70dvh] place-items-center px-4 pt-20 text-center">
      <div>
        <AvatarHead className="mx-auto h-24 w-24" />
        <p className="sr-only">404</p>
        <div aria-hidden className="mt-6 flex justify-center">
          <SplitFlapText words={['404', 'NOT FOUND', '404']} padTo={9} fontSize="clamp(34px, 10.2vw, 88px)" gap="clamp(4px, 1vw, 10px)" tileRadius="clamp(5px, 1vw, 12px)" tileColor="#111a2f" textColor="#9bbfff" cycleDelay={2600} />
        </div>
        <h1 className="mt-2 text-2xl font-bold">We couldn't find that page</h1>
        <p className="mt-2 text-fog">It may have moved, or the link might be mistyped.</p>
        <div className="mt-7 flex justify-center gap-3"><ButtonLink to="/">Go home</ButtonLink><Link to="/app" className="inline-flex h-11 items-center rounded-2xl px-5 text-sm font-semibold text-mist hover:bg-white/[0.06]">Open app</Link></div>
      </div>
    </div>
  );
}
