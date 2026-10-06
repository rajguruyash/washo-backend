import { useState } from 'react';
import { EmptyState, ErrorState, PageHeader } from '../../components/EmptyState';
import { BookingCard } from '../../components/WashBits';
import { ButtonLink } from '../../components/ui/Button';
import { Segmented } from '../../components/ui/Segmented';
import { Skeleton } from '../../components/ui/Skeleton';
import { useBookings } from '../../lib/queries';

export default function Bookings() {
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const { data, isLoading, isError, refetch } = useBookings(tab, tab === 'upcoming');
  return (
    <>
      <PageHeader title="Washes" subtitle="Every wash, from membership or single bookings." action={<ButtonLink to="/app/book" variant="glass">Book a single wash</ButtonLink>} />
      <Segmented label="Washes" value={tab} onChange={setTab} options={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Completed & past' }]} />
      <div className="mt-5 space-y-3">
        {isError ? <ErrorState onRetry={() => void refetch()} /> : isLoading ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />) : data?.length ? data.map((b, i) => <BookingCard key={b.id} booking={b} index={i} />) : (
          <EmptyState title={tab === 'upcoming' ? 'No upcoming washes' : 'Nothing here yet'} text={tab === 'upcoming' ? 'Start a membership or book a single wash.' : 'Completed and cancelled washes will appear here.'} action={tab === 'upcoming' ? <ButtonLink to="/app/membership/new">Start a membership</ButtonLink> : undefined} />
        )}
      </div>
    </>
  );
}
