import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import GlareHover from './reactbits/GlareHover';

/**
 * React Bits Glare Hover around a campaign block: a gold sweep of light on hover or touch, and a gentle glint every few seconds so the
 * offer catches the eye. The block inside keeps its own look (border, blur); this only adds the light on top.
 */
export function CampaignGlare({ children, radius = '1.5rem', glintEvery = 7000, className }: { children: ReactNode; radius?: string; glintEvery?: number; className?: string }) {
  return (
    <GlareHover
      width="100%"
      height="auto"
      background="transparent"
      borderColor="transparent"
      borderRadius={radius}
      glareColor="#ffd84d"
      glareOpacity={0.32}
      glareAngle={-35}
      glareSize={260}
      transitionDuration={900}
      glintEvery={glintEvery}
      className={cn('block', className)}
      style={{ borderWidth: 0 }}
    >
      {children}
    </GlareHover>
  );
}
