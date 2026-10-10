import { AnimatePresence, motion } from 'framer-motion';
import { Pencil, Star } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { ApiError } from '../lib/http';
import { useRateWash } from '../lib/queries';
import type { WashReview } from '../lib/types';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';
import { TextArea } from './ui/Field';
import { useToast } from './ui/Toast';

const WORDS = ['', 'Poor', 'Could be better', 'Good', 'Very good', 'Excellent'] as const;

/** What the rating component needs to know about a wash: which one, whether it is done, and the rating so far. */
export interface Rateable { id: string; status: string; review?: WashReview | null }

/** Five stars. With `onPick` they are buttons (a radio group); without, they only show a rating. */
export function Stars({ value, onPick, size = 20, label = 'Rating', className }: { value: number; onPick?: (n: number) => void; size?: number; label?: string; className?: string }) {
  const star = (n: number) => <Star style={{ width: size, height: size }} className={cn('transition-colors', n <= value ? 'fill-offer text-offer' : 'text-white/30')} aria-hidden />;
  if (!onPick) {
    return <span role="img" aria-label={value ? `${value} out of 5 stars` : 'Not rated'} className={cn('inline-flex items-center gap-0.5', className)}>{[1, 2, 3, 4, 5].map((n) => <span key={n}>{star(n)}</span>)}</span>;
  }
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex items-center gap-1', className)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}: ${WORDS[n]}`}
          onClick={() => onPick(n)}
          className="grid place-items-center rounded-lg p-1 transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-washo-400 active:scale-95"
        >
          {star(n)}
        </button>
      ))}
    </div>
  );
}

/**
 * Rate a finished wash. Pick the stars and a box for a review opens under them; the review is optional, so the stars can be sent alone. Sending again changes the
 * rating or the words (nothing is ever locked in). The database checks that this is the customer's own wash and that it has been done.
 */
export function WashRatingForm({ wash, initial = 0, onDone, onCancel }: { wash: Rateable; initial?: number; onDone?: () => void; onCancel?: () => void }) {
  const rate = useRateWash();
  const toast = useToast();
  const [rating, setRating] = useState(initial || wash.review?.rating || 0);
  const [text, setText] = useState(wash.review?.review ?? '');
  const [error, setError] = useState('');
  const had = Boolean(wash.review);

  const submit = async () => {
    setError('');
    try {
      await rate.mutateAsync({ id: wash.id, rating, review: text });
      toast.success(had ? 'Your rating is updated' : 'Thanks for rating your wash!');
      onDone?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Stars value={rating} onPick={(n) => { setRating(n); setError(''); }} size={34} label="How was your wash?" />
        <span aria-live="polite" className="min-h-5 text-sm font-semibold text-offer">{WORDS[rating]}</span>
      </div>
      <AnimatePresence initial={false}>
        {rating > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="space-y-3 pt-4">
              <TextArea label="Write a review" optional value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder="What went well, or what could be better? You can skip this." hint={`${text.length}/1000`} />
              {error && <p role="alert" className="text-sm text-bad">{error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button loading={rate.isPending} onClick={() => void submit()}>{text.trim() ? 'Submit review' : 'Submit rating'}</Button>
                {onCancel && <Button variant="glass" disabled={rate.isPending} onClick={onCancel}>Cancel</Button>}
              </div>
              {!text.trim() && <p className="text-xs text-fog">Just the stars is fine. You can add words later.</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** What the customer said, with a way to change it. */
export function YourRating({ review, onChange }: { review: WashReview; onChange: () => void }) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Stars value={review.rating} size={22} /><span className="text-sm font-semibold text-offer">{WORDS[review.rating]}</span></div>
        <button type="button" onClick={onChange} className="inline-flex items-center gap-1.5 text-sm font-semibold text-washo-300 hover:text-white"><Pencil className="h-3.5 w-3.5" aria-hidden /> Change</button>
      </div>
      {review.review ? <p className="mt-2 whitespace-pre-wrap text-sm text-mist">{review.review}</p> : <button type="button" onClick={onChange} className="mt-1 text-sm text-fog hover:text-white">Add a review</button>}
    </div>
  );
}

/** The rating block on a finished wash's own page: the form until they have rated, then what they said. Renders nothing for a wash that is not done. */
export function WashRatingSection({ wash, className }: { wash: Rateable; className?: string }) {
  const [editing, setEditing] = useState(false);
  if (wash.status !== 'completed') return null;
  return (
    <section className={cn('glass p-5', className)} aria-label="Rate this wash">
      <h2 className="mb-3 text-lg font-bold">{wash.review && !editing ? 'Your rating' : 'How was your wash?'}</h2>
      {wash.review && !editing ? <YourRating review={wash.review} onChange={() => setEditing(true)} /> : <WashRatingForm key={String(editing)} wash={wash} onDone={() => setEditing(false)} onCancel={wash.review ? () => setEditing(false) : undefined} />}
    </section>
  );
}

/** The strip on a wash in the Washes tab: five stars to tap (or the rating already given). Opens a sheet to finish: the stars, then an optional review. */
export function RatingStrip({ wash, className }: { wash: Rateable; className?: string }) {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState(0);
  if (wash.status !== 'completed') return null;
  const rated = wash.review;
  return (
    <>
      <div className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-1', className)}>
        <div className="flex items-center gap-2">
          <Stars value={rated?.rating ?? 0} size={22} label="Rate this wash" onPick={(n) => { setFirst(n); setOpen(true); }} />
          <span className="text-xs font-semibold text-fog">{rated ? 'Your rating' : 'Rate this wash'}</span>
        </div>
        {rated && <button type="button" onClick={() => { setFirst(rated.rating); setOpen(true); }} className="text-xs font-semibold text-washo-300 hover:text-white">{rated.review ? 'Edit review' : 'Add review'}</button>}
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} size="sm" title={rated ? 'Your rating' : 'How was your wash?'} description={rated ? 'Change the stars or the words any time.' : 'Pick the stars. A review is optional.'}>
        {open && <WashRatingForm key={first} wash={wash} initial={first} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />}
      </Sheet>
    </>
  );
}
