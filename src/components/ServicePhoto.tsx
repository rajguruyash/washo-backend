import { servicePhoto } from '../lib/serviceImages';
import { cn } from '../lib/cn';
import { ServiceArt } from './brand/ServiceArt';

const art = (code: string) => (code.startsWith('bike') ? 'bike_wash' : code.startsWith('suv') ? 'suv_deep_clean' : code.includes('deep') ? 'car_deep_clean' : 'car_body_wash');

/** The photo for a service, cropped to fill its box. Falls back to the illustration for a service without one. */
export function ServicePhoto({ code, name, className, position = 'center 30%' }: { code: string; name: string; className?: string; position?: string }) {
  const src = servicePhoto(code);
  return (
    <div className={cn('relative overflow-hidden bg-ink-900', className)}>
      {src ? (
        <img src={src} alt={`${name}: a WASHO specialist at work`} loading="lazy" decoding="async" className="h-full w-full object-cover" style={{ objectPosition: position }} />
      ) : (
        <ServiceArt scene={art(code)} />
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-ink-950/50 to-transparent" />
    </div>
  );
}
