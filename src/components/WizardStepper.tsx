import { Fragment } from 'react';
import { StepConnector, StepIndicator } from './reactbits/Stepper';

const THEMES = {
  washo: { accent: '#3f7cff', idle: '#16213b', idleText: '#93a1bf', ink: '#05080f', track: 'rgba(255,255,255,0.12)' },
  offer: { accent: '#ffd84d', idle: '#16213b', idleText: '#93a1bf', ink: '#05080f', track: 'rgba(255,255,255,0.12)' },
};

/**
 * The progress of a booking, as React Bits Stepper draws it: a numbered circle for each step joined by lines that fill as you go, a tick that
 * draws itself on a finished step, and a dot on the step you are on. A finished step can be tapped to go back to it; a step ahead cannot
 * (the wizard's own Continue button checks each step before moving on, so a step is never skipped).
 */
export function WizardStepper({ steps, step, onStep, theme = 'washo' }: { steps: readonly string[]; step: number; onStep: (i: number) => void; theme?: keyof typeof THEMES }) {
  const t = THEMES[theme];
  return (
    <div className="mb-8">
      <ol className="flex w-full items-center" aria-label="Progress">
        {steps.map((label, i) => (
          <Fragment key={label}>
            <li className="flex shrink-0 items-center">
              <StepIndicator
                step={i + 1}
                currentStep={step + 1}
                disableStepIndicators={i >= step}
                onClickStep={(n) => onStep(n - 1)}
                accent={t.accent}
                idle={t.idle}
                idleText={t.idleText}
                ink={t.ink}
                label={i < step ? `Back to ${label}` : `Step ${i + 1}: ${label}`}
              />
            </li>
            {i < steps.length - 1 && <StepConnector isComplete={step > i} accent={t.accent} track={t.track} />}
          </Fragment>
        ))}
      </ol>
      <p className="mt-3 text-sm font-semibold text-mist" aria-live="polite">Step {step + 1} of {steps.length} · {steps[step]}</p>
    </div>
  );
}
