import { cn } from '../../lib/cn';

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn('skeleton', className)} />;

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('panel space-y-3 p-5', className)} role="status" aria-label="Loading">
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
