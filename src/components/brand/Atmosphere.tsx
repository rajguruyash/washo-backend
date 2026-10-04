/** Fixed ambient background: two slow blue orbs on near-black. Cheap (static blur, transform-only motion). */
export function Atmosphere() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-950">
      <div className="absolute -left-40 -top-40 h-[34rem] w-[34rem] animate-orbit rounded-full bg-washo-700/30 blur-[120px]" />
      <div className="absolute -right-40 top-1/3 h-[30rem] w-[30rem] animate-orbit rounded-full bg-washo-500/15 blur-[120px] [animation-delay:-12s] [animation-direction:alternate-reverse]" />
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{ backgroundImage: 'linear-gradient(rgb(255 255 255) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255) 1px, transparent 1px)', backgroundSize: '56px 56px' }}
      />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink-950 to-transparent" />
    </div>
  );
}
