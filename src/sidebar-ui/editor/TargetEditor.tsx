import { useEffect, useState } from 'react';
import type { TargetTestResult } from '@shared/messages';
import { SELECTOR_PRIORITY, type ElementTarget, type SelectorKind, type SelectorStrategy } from '@shared/model/selector';
import { useApp } from '../App';
import { requestAccess, send } from '../api';
import { Button, CommitInput, IconButton, Menu, useToast } from '../components/ui';
import { verdictLabel } from './FailurePanel';

function strategyKey(strategy: SelectorStrategy): string {
  return `${strategy.kind}|${strategy.attr ?? ''}|${strategy.value}`;
}

const ADDABLE: { kind: SelectorKind; label: string; attr?: string }[] = [
  { kind: 'testId', label: 'Test ID', attr: 'data-testid' },
  { kind: 'css', label: 'CSS selector' },
  { kind: 'xpath', label: 'XPath' },
  { kind: 'text', label: 'Exact text' },
];

function sortStrategies(selectors: SelectorStrategy[]): SelectorStrategy[] {
  const rank = (strategy: SelectorStrategy) => SELECTOR_PRIORITY.indexOf(strategy.kind);
  return [...selectors].sort((a, b) => rank(a) - rank(b));
}

/** Runs `pick` and hands back the chosen element. Exposed so empty steps can use it too. */
export function usePicker(onPicked: (target: ElementTarget) => void) {
  const { targetUrl } = useApp();
  const toast = useToast();
  const [picking, setPicking] = useState(false);

  const pick = () => {
    setPicking(true);
    requestAccess([targetUrl])
      .then(() => send<ElementTarget | null>({ type: 'inspect/pick' }))
      .then((target) => {
        if (target) onPicked(target);
      })
      .catch(toast.error)
      .finally(() => setPicking(false));
  };
  const cancel = () => void send({ type: 'inspect/cancelPick' }).catch(toast.error);
  return { picking, pick, cancel };
}

interface TargetEditorProps {
  label: string;
  target: ElementTarget | undefined;
  onChange: (target: ElementTarget) => void;
}

export function TargetEditor({ label, target, onChange }: TargetEditorProps) {
  const { targetUrl } = useApp();
  const toast = useToast();
  const { picking, pick, cancel } = usePicker(onChange);
  const [results, setResults] = useState<TargetTestResult | null>(null);
  const [highlighted, setHighlighted] = useState(false);

  useEffect(() => {
    if (!highlighted) return undefined;
    return () => void send({ type: 'inspect/clear' }).catch(() => undefined);
  }, [highlighted]);

  const pickButton = picking ? (
    <Button onClick={cancel}>Cancel picking</Button>
  ) : (
    <Button icon="target" data-testid="pick-element" onClick={pick}>{target ? 'Pick again' : 'Pick element'}</Button>
  );

  if (!target) {
    return (
      <div className="target-empty">
        <span className="field-hint">No element chosen yet.</span>
        {pickButton}
      </div>
    );
  }

  const toggleHighlight = () => {
    if (highlighted) {
      setHighlighted(false);
      return;
    }
    requestAccess([targetUrl])
      .then(() => send<boolean>({ type: 'inspect/highlight', target }))
      .then((found) => {
        if (found) setHighlighted(true);
        else toast.info("The element isn't on the current page.");
      })
      .catch(toast.error);
  };

  const test = () => {
    requestAccess([targetUrl])
      .then(() => send<TargetTestResult>({ type: 'inspect/test', target }))
      .then((result) => {
        setResults(result);
        if (result.error) toast.info(result.error);
      })
      .catch(toast.error);
  };

  const updateSelector = (index: number, change: Partial<SelectorStrategy>) => {
    onChange({
      ...target,
      selectors: target.selectors.map((selector, i) => (i === index ? { ...selector, ...change } : selector)),
    });
  };
  const removeSelector = (index: number) => {
    onChange({ ...target, selectors: target.selectors.filter((_, i) => i !== index) });
  };
  const addSelector = (kind: SelectorKind, attr?: string) => {
    onChange({ ...target, selectors: sortStrategies([...target.selectors, { kind, value: '', ...(attr ? { attr } : {}) }]) });
  };

  const resultFor = (selector: SelectorStrategy) =>
    results?.attempts.find((attempt) => strategyKey(attempt.strategy) === strategyKey(selector));

  return (
    <div className="target">
      <div className="target-summary">
        <span className="target-name" title={target.summary}>{target.summary}</span>
        {target.frames?.length ? <span className="tag">in frame</span> : null}
      </div>
      <div className="target-actions">
        <Button icon="eye" className={highlighted ? 'is-on' : ''} aria-pressed={highlighted} data-testid="highlight" onClick={toggleHighlight}>
          Highlight
        </Button>
        {pickButton}
        <Button data-testid="test-selectors" onClick={test}>Test</Button>
      </div>
      <details className="selectors">
        <summary>{label} ({target.selectors.filter((selector) => !selector.disabled).length} active)</summary>
        <p className="field-hint">Tried from the top. The first that identifies exactly one matching element wins.</p>
        <ul className="selector-list">
          {target.selectors.map((selector, index) => {
            const result = resultFor(selector);
            const isFingerprint = selector.kind === 'context';
            return (
              <li key={`${selector.kind}-${index}`} className={`selector-row ${selector.disabled ? 'is-off' : ''}`} data-kind={selector.kind}>
                <input
                  type="checkbox"
                  aria-label={`Use ${selector.kind} selector`}
                  checked={!selector.disabled}
                  onChange={(event) => updateSelector(index, { disabled: !event.target.checked })}
                />
                <span className="selector-kind" title={selector.attr ?? selector.role}>{selector.kind}</span>
                {isFingerprint ? (
                  <span className="field-hint grow">Scores elements against the recorded details</span>
                ) : (
                  <div className="grow">
                    <CommitInput mono label={`${selector.kind} value`} value={selector.value} onCommit={(value) => updateSelector(index, { value })} />
                  </div>
                )}
                {result && <span className={`selector-result verdict-${result.verdict}`}>{verdictLabel(result)}</span>}
                <IconButton icon="close" label={`Remove ${selector.kind} selector`} onClick={() => removeSelector(index)} />
              </li>
            );
          })}
        </ul>
        <Menu
          label="Add selector"
          icon="plus"
          items={ADDABLE.map(({ kind, label: name, attr }) => ({ label: name, onSelect: () => addSelector(kind, attr) }))}
        />
      </details>
    </div>
  );
}
