import { Star } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '../../components/EmptyState';
import { Segmented } from '../../components/ui/Segmented';
import { Stars } from '../../components/WashRating';
import { prettyDate, relativeTime } from '../../lib/format';
import { useAdminReviews } from '../../lib/queries';
import { Loading } from './shared';

/** What customers said about their washes: the average, how many of each star, and the latest ratings (all, or only the low ones, up to 3 stars). */
export default function Reviews() {
  const [low, setLow] = useState<'all' | 'low'>('all');
  const { data, isLoading, isError, refetch } = useAdminReviews(low === 'low' ? 3 : null);
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (isLoading || !data) return <Loading />;
  const { summary, reviews } = data;
  const most = Math.max(1, ...Object.values(summary.stars));
  return (
    <div className="space-y-6">
      <section className="glass grid gap-6 p-5 sm:grid-cols-[auto_1fr]">
        <div className="text-center sm:text-left">
          <p className="font-display text-5xl font-extrabold tabular-nums">{summary.count ? summary.average.toFixed(1) : '-'}</p>
          <Stars value={Math.round(summary.average)} size={22} />
          <p className="mt-1 text-sm text-fog">{summary.count} rating{summary.count === 1 ? '' : 's'} · {summary.with_text} with a review</p>
        </div>
        <ul className="space-y-1.5" aria-label="Ratings by stars">
          {([5, 4, 3, 2, 1] as const).map((n) => (
            <li key={n} className="flex items-center gap-3 text-sm">
              <span className="flex w-9 items-center justify-end gap-1 font-semibold">{n} <Star className="h-3.5 w-3.5 fill-offer text-offer" aria-hidden /></span>
              <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full bg-gradient-to-r from-washo-500 to-washo-300" style={{ width: `${(summary.stars[String(n) as '1'] / most) * 100}%` }} /></span>
              <span className="w-8 tabular-nums text-fog">{summary.stars[String(n) as '1']}</span>
            </li>
          ))}
        </ul>
      </section>

      <Segmented label="Which ratings" value={low} onChange={setLow} options={[{ value: 'all', label: 'All ratings' }, { value: 'low', label: 'Low (3 stars or less)' }]} />

      {!reviews.length ? <p className="panel p-8 text-center text-fog">{low === 'low' ? 'No low ratings. 🎉' : 'Nobody has rated a wash yet.'}</p> : (
        <ul className="space-y-2">
          {reviews.map((r) => (
            <li key={r.id} className="glass p-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div className="min-w-0"><Stars value={r.rating} size={18} /><p className="mt-1 truncate font-semibold">{r.customer_name ?? 'Customer'} <span className="font-normal text-fog">· {r.service_name}{r.booking_type === 'membership' ? ' · membership' : ''}</span></p></div>
                <p className="text-xs text-fog">{relativeTime(r.updated_at)}</p>
              </div>
              {r.review ? <p className="mt-2 whitespace-pre-wrap text-sm text-mist">{r.review}</p> : <p className="mt-2 text-xs text-fog">Stars only, no review.</p>}
              <p className="mt-2 text-xs text-fog">{prettyDate(r.scheduled_date)} · {r.vehicle_model} {r.registration_number} · {r.worker_name ? `by ${r.worker_name}` : 'specialist not recorded'}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
