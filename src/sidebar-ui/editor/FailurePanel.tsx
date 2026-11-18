import type { StepFailure } from '@shared/model/execution';
import type { SelectorAttempt } from '@shared/model/selector';
import type { SetupActionType } from '@shared/model/setup';
import type { ActionType } from '@shared/model/step';
import { setupActionLabel } from '@shared/setup';
import { actionTypeLabel } from '@shared/steps';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';

const VERDICT_LABEL: Record<SelectorAttempt['verdict'], string> = {
  resolved: 'matched',
  disambiguated: 'matched best',
  'no-match': 'no match',
  ambiguous: 'ambiguous',
  mismatch: 'wrong element',
  invalid: 'invalid',
  'not-tried': 'not tried',
};

export function verdictLabel(attempt: Pick<SelectorAttempt, 'verdict' | 'matchCount'>): string {
  return attempt.verdict === 'ambiguous' ? `${attempt.matchCount} matches` : VERDICT_LABEL[attempt.verdict];
}

export function AttemptList({ attempts }: { attempts: SelectorAttempt[] }) {
  return (
    <ul className="attempts">
      {attempts.map((attempt, index) => (
        <li key={index} className={`attempt verdict-${attempt.verdict}`} title={attempt.detail}>
          <span className="attempt-kind">{attempt.strategy.kind}</span>
          <span className="attempt-value mono">{attempt.strategy.value}</span>
          <span className="attempt-verdict">{verdictLabel(attempt)}</span>
        </li>
      ))}
    </ul>
  );
}

interface FailurePanelProps {
  failure: StepFailure;
  onRetry: () => void;
  onSkip: () => void;
  onStop: () => void;
  onReveal: () => void;
  /** Grants access to the failed page, then retries. */
  onAllowAndRetry: () => void;
}

function failureActionLabel(failure: StepFailure): string {
  return failure.phase === 'setup'
    ? setupActionLabel(failure.action as SetupActionType)
    : actionTypeLabel(failure.action as ActionType);
}

export function FailurePanel({ failure, onRetry, onSkip, onStop, onReveal, onAllowAndRetry }: FailurePanelProps) {
  const isSetup = failure.phase === 'setup';
  return (
    <section className="failure" role="alert" data-testid="failure" data-code={failure.code}>
      <button type="button" className="failure-title" onClick={onReveal} title="Show this step">
        <Icon name="alert" size={14} />
        {isSetup ? 'Setup step' : 'Step'} {failure.stepIndex + 1} failed: {failure.stepName}
      </button>
      <p className="failure-message">{failure.message}</p>
      {failure.hint && <p className="failure-hint">{failure.hint}</p>}
      <dl className="failure-facts">
        <dt>Action</dt>
        <dd>{failureActionLabel(failure)}</dd>
        {failure.targetSummary && (
          <>
            <dt>Expected</dt>
            <dd>{failure.targetSummary}</dd>
          </>
        )}
        {failure.actual && (
          <>
            <dt>Actual</dt>
            <dd>{failure.actual}</dd>
          </>
        )}
        {failure.url && (
          <>
            <dt>Page</dt>
            <dd className="mono">{failure.url}</dd>
          </>
        )}
      </dl>
      {failure.attempts && failure.attempts.length > 0 && (
        <details>
          <summary>Selectors tried ({failure.attempts.filter((attempt) => attempt.verdict !== 'not-tried').length})</summary>
          <AttemptList attempts={failure.attempts} />
        </details>
      )}
      <div className="failure-actions">
        {failure.code === 'no-page-access' ? (
          <Button variant="primary" icon="shield" data-testid="allow-and-retry" onClick={onAllowAndRetry}>Allow this site and retry</Button>
        ) : (
          <Button variant="primary" icon="restart" data-testid="retry" onClick={onRetry}>Retry</Button>
        )}
        <Button data-testid="skip-failed" onClick={onSkip}>Skip step</Button>
        <Button variant="ghost" onClick={onStop}>Stop</Button>
      </div>
    </section>
  );
}
