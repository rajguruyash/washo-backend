// React Bits Glare Hover (https://reactbits.dev/animations/glare-hover), MIT + Commons Clause.
// Adapted for WASHO: the glare also plays on touch and keyboard focus (phones have no hover), can glint by itself every few seconds to draw
// the eye (`glintEvery`), respects reduced motion, and the wrapper is not forced to be a pointer or to centre its children.
import React, { useEffect, useRef } from 'react';

interface GlareHoverProps {
  width?: string;
  height?: string;
  background?: string;
  borderRadius?: string;
  borderColor?: string;
  children?: React.ReactNode;
  glareColor?: string;
  glareOpacity?: number;
  glareAngle?: number;
  glareSize?: number;
  transitionDuration?: number;
  playOnce?: boolean;
  /** Milliseconds between glints that play without any hover. 0 (the default) means only on hover, touch or focus. */
  glintEvery?: number;
  className?: string;
  style?: React.CSSProperties;
}

const GlareHover: React.FC<GlareHoverProps> = ({
  width = '500px',
  height = '500px',
  background = '#000',
  borderRadius = '10px',
  borderColor = '#333',
  children,
  glareColor = '#ffffff',
  glareOpacity = 0.5,
  glareAngle = -45,
  glareSize = 250,
  transitionDuration = 650,
  playOnce = false,
  glintEvery = 0,
  className = '',
  style = {}
}) => {
  const hex = glareColor.replace('#', '');
  let rgba = glareColor;
  if (/^[\dA-Fa-f]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    rgba = `rgba(${r}, ${g}, ${b}, ${glareOpacity})`;
  } else if (/^[\dA-Fa-f]{3}$/.test(hex)) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    rgba = `rgba(${r}, ${g}, ${b}, ${glareOpacity})`;
  }

  const overlayRef = useRef<HTMLDivElement | null>(null);

  const animateIn = () => {
    const el = overlayRef.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    el.style.transition = 'none';
    el.style.backgroundPosition = '-100% -100%, 0 0';
    // Force the browser to apply the reset before the sweep starts.
    void el.offsetWidth;
    el.style.transition = `${transitionDuration}ms ease`;
    el.style.backgroundPosition = '100% 100%, 0 0';
  };

  const animateOut = () => {
    const el = overlayRef.current;
    if (!el) return;

    if (playOnce) {
      el.style.transition = 'none';
      el.style.backgroundPosition = '-100% -100%, 0 0';
    } else {
      el.style.transition = `${transitionDuration}ms ease`;
      el.style.backgroundPosition = '-100% -100%, 0 0';
    }
  };

  useEffect(() => {
    if (glintEvery <= 0) return undefined;
    let reset = 0;
    const timer = window.setInterval(() => {
      animateIn();
      reset = window.setTimeout(() => {
        const el = overlayRef.current;
        if (!el) return;
        el.style.transition = 'none';
        el.style.backgroundPosition = '-100% -100%, 0 0';
      }, transitionDuration + 80);
    }, glintEvery);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(reset);
    };
    // The sweep only reads refs and the duration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glintEvery, transitionDuration]);

  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    background: `linear-gradient(${glareAngle}deg,
        hsla(0,0%,0%,0) 60%,
        ${rgba} 70%,
        hsla(0,0%,0%,0) 100%)`,
    backgroundSize: `${glareSize}% ${glareSize}%, 100% 100%`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: '-100% -100%, 0 0',
    pointerEvents: 'none'
  };

  return (
    <div
      className={`relative overflow-hidden border ${className}`}
      style={{
        width,
        height,
        background,
        borderRadius,
        borderColor,
        ...style
      }}
      onMouseEnter={animateIn}
      onMouseLeave={animateOut}
      onTouchStart={animateIn}
      onTouchEnd={animateOut}
      onFocus={animateIn}
      onBlur={animateOut}
    >
      {children}
      <div ref={overlayRef} style={overlayStyle} aria-hidden="true" />
    </div>
  );
};

export default GlareHover;
