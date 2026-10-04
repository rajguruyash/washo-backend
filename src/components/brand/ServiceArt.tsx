import { useId } from 'react';
import { cn } from '../../lib/cn';

type Scene = 'bike_wash' | 'car_body_wash' | 'car_deep_clean' | 'suv_deep_clean';

const bubble = (cx: number, cy: number, r: number, delay: number) => (
  <circle
    key={`${cx}-${cy}`}
    cx={cx}
    cy={cy}
    r={r}
    fill="rgb(155 191 255 / 0.12)"
    stroke="rgb(196 205 224 / 0.55)"
    strokeWidth="1"
    style={{ animation: `art-bubble 4.2s ease-in-out ${delay}s infinite`, transformBox: 'fill-box', transformOrigin: 'center' }}
  />
);

const sparkle = (x: number, y: number, s: number, delay: number) => (
  <path
    key={`${x}-${y}`}
    d={`M${x} ${y - s} L${x + s * 0.28} ${y - s * 0.28} L${x + s} ${y} L${x + s * 0.28} ${y + s * 0.28} L${x} ${y + s} L${x - s * 0.28} ${y + s * 0.28} L${x - s} ${y} L${x - s * 0.28} ${y - s * 0.28} Z`}
    fill="#ffd84d"
    style={{ animation: `art-twinkle 2.6s ease-in-out ${delay}s infinite`, transformBox: 'fill-box', transformOrigin: 'center' }}
  />
);

function Wheel({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r + 6} fill="#05080f" />
      <circle cx={cx} cy={cy} r={r} fill="#0a101c" stroke="#3f7cff" strokeOpacity=".9" strokeWidth="2.5" />
      <circle cx={cx} cy={cy} r={r * 0.55} fill="#111a2f" stroke="#c4cde0" strokeOpacity=".6" strokeWidth="1.5" />
      <circle cx={cx} cy={cy} r={r * 0.14} fill="#c4cde0" />
    </g>
  );
}

function Vehicle({ kind, body }: { kind: 'bike' | 'car' | 'suv'; body: string }) {
  if (kind === 'bike') {
    return (
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="112" cy="180" r="38" stroke="#3f7cff" strokeWidth="7" strokeOpacity=".9" />
        <circle cx="112" cy="180" r="9" fill="#c4cde0" stroke="none" />
        <circle cx="300" cy="180" r="38" stroke="#3f7cff" strokeWidth="7" strokeOpacity=".9" />
        <circle cx="300" cy="180" r="9" fill="#c4cde0" stroke="none" />
        <path d="M112 180 L158 138 L236 142" stroke="#c4cde0" strokeWidth="5" strokeOpacity=".75" />
        <path d="M300 180 L268 112" stroke="#c4cde0" strokeWidth="6" strokeOpacity=".85" />
        <path d="M256 106 L290 100" stroke="#c4cde0" strokeWidth="6" />
        <path d="M168 126 Q200 100 246 116 L240 142 L176 146 Z" fill={`url(#${body})`} stroke="#6a9cff" strokeWidth="2.5" />
        <path d="M122 128 Q150 112 180 124 L176 142 L124 146 Z" fill="#0d1527" stroke="#6a9cff" strokeWidth="2" />
        <rect x="178" y="146" width="58" height="30" rx="8" fill="#111a2f" stroke="#6a9cff" strokeOpacity=".7" strokeWidth="2" />
        <path d="M186 172 L92 180" stroke="#c4cde0" strokeWidth="5" strokeOpacity=".6" />
        <circle cx="288" cy="120" r="9" fill="#9bbfff" stroke="none" />
        <circle cx="288" cy="120" r="16" fill="#9bbfff" opacity=".18" stroke="none" />
      </g>
    );
  }
  const suv = kind === 'suv';
  return (
    <g>
      <path
        d={
          suv
            ? 'M36 180 L36 150 Q36 140 52 137 L100 128 Q116 98 152 92 L284 90 Q314 92 330 112 L354 136 Q366 142 366 158 L366 180 Z'
            : 'M38 178 L38 158 Q38 148 54 145 L104 136 Q128 110 170 105 L246 103 Q288 105 306 134 L348 142 Q364 146 364 160 L364 178 Z'
        }
        fill={`url(#${body})`}
        stroke="#6a9cff"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d={suv ? 'M114 126 Q128 104 154 99 L200 98 L200 126 Z M210 98 L284 97 Q306 99 318 118 L326 128 L210 128 Z' : 'M120 134 Q140 114 172 110 L206 109 L206 134 Z M216 109 L246 108 Q272 110 290 134 L216 134 Z'}
        fill="#0a101c"
        stroke="#9bbfff"
        strokeOpacity=".55"
        strokeWidth="1.5"
      />
      {suv && <path d="M150 88 L286 86" stroke="#c4cde0" strokeOpacity=".7" strokeWidth="3.5" strokeLinecap="round" />}
      <path d="M40 160 L58 160" stroke="#9bbfff" strokeWidth="6" strokeLinecap="round" />
      <path d="M356 160 L342 160" stroke="#ff6b7a" strokeWidth="6" strokeLinecap="round" />
      <Wheel cx={110} cy={suv ? 182 : 180} r={suv ? 28 : 26} />
      <Wheel cx={292} cy={suv ? 182 : 180} r={suv ? 28 : 26} />
    </g>
  );
}

/** Illustrated service scene on a dark glass tile. Swap for photography by passing `src` in the future. */
export function ServiceArt({ scene, className }: { scene: Scene | string; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const id = (n: string) => `art-${n}-${uid}`;
  const kind = scene === 'bike_wash' ? 'bike' : scene === 'suv_deep_clean' ? 'suv' : 'car';
  const deep = scene === 'car_deep_clean' || scene === 'suv_deep_clean';
  return (
    <svg viewBox="0 0 400 260" className={cn('h-full w-full', className)} role="img" aria-label={`${scene.replace(/_/g, ' ')} illustration`} preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id={id('glow')} cx="50%" cy="62%" r="60%">
          <stop offset="0" stopColor="#2a62e6" stopOpacity=".55" />
          <stop offset="1" stopColor="#2a62e6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('bg')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0d1527" />
          <stop offset="1" stopColor="#060a14" />
        </linearGradient>
        <linearGradient id={id('body')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#27406f" />
          <stop offset="1" stopColor="#0f1a33" />
        </linearGradient>
        <linearGradient id={id('spray')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9bbfff" stopOpacity=".95" />
          <stop offset="1" stopColor="#9bbfff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="400" height="260" fill={`url(#${id('bg')})`} />
      <rect width="400" height="260" fill={`url(#${id('glow')})`} />
      <path d="M0 214 H400" stroke="#27355c" strokeOpacity=".7" />
      <ellipse cx="200" cy="222" rx="170" ry="12" fill="#3f7cff" opacity=".18" />
      <ellipse cx="200" cy="222" rx="120" ry="6" fill="#000" opacity=".5" />

      <Vehicle kind={kind} body={id('body')} />

      {/* pressure-wash spray */}
      <g fill="none" stroke={`url(#${id('spray')})`} strokeWidth="3" strokeLinecap="round" strokeDasharray="2 9" style={{ animation: 'art-spray 1.2s linear infinite' }}>
        <path d="M18 70 Q120 52 214 104" />
        <path d="M18 82 Q110 76 190 118" />
        <path d="M24 58 Q128 36 236 92" />
      </g>
      <circle cx="16" cy="72" r="6" fill="#9bbfff" opacity=".9" />

      {bubble(150, 84, 9, 0)}
      {bubble(190, 68, 6, 0.8)}
      {bubble(236, 80, 11, 1.6)}
      {bubble(272, 64, 5, 2.2)}
      {bubble(120, 108, 5, 1.2)}

      {deep && (
        <g>
          {sparkle(312, 56, 14, 0)}
          {sparkle(344, 98, 9, 0.9)}
          {sparkle(84, 46, 10, 1.7)}
          {sparkle(176, 150, 8, 0.5)}
        </g>
      )}
    </svg>
  );
}
