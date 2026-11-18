import { useCallback, useState } from 'react';
import type { Command, PlaybackRange } from '@shared/messages';
import type { Recording } from '@shared/model/recording';
import { setupUrls } from '@shared/setup';
import { variablesToPrompt } from '@shared/variables';
import { useApp } from '../App';
import { requestAccess, send } from '../api';
import { useToast } from '../components/ui';

export interface RunRequest {
  range?: PlaybackRange;
  /** Start paused, then run just the first step. */
  stepping?: boolean;
}

export interface VariablePrompt {
  request: RunRequest;
  fields: ReturnType<typeof variablesToPrompt>;
}

function urlsOf(recording: Recording, targetUrl: string | null): (string | null)[] {
  const urls: (string | null)[] = [targetUrl, recording.startUrl];
  for (const item of recording.setup) {
    if (item.enabled) urls.push(...setupUrls(item.action, recording.startUrl));
  }
  for (const step of recording.steps) {
    if (step.action.type === 'navigate' && !step.action.url.includes('{{')) urls.push(step.action.url);
  }
  return urls;
}

/** Everything the editor needs to start and control a run of this recording. */
export function usePlayback(recording: Recording) {
  const { targetUrl, settings } = useApp();
  const toast = useToast();
  const [prompt, setPrompt] = useState<VariablePrompt | null>(null);
  const [speed, setSpeed] = useState(settings.defaultSpeed);

  const command = useCallback(
    (message: Command) => {
      send(message).catch(toast.error);
    },
    [toast],
  );

  /** Must run synchronously inside a click, because of the permission request. */
  const launch = (request: RunRequest, variables: Record<string, string>) => {
    requestAccess(urlsOf(recording, targetUrl))
      .then(async (granted) => {
        if (!granted) throw new Error('Playback needs access to the sites in this recording.');
        await send({
          type: 'playback/start',
          recordingId: recording.id,
          variables,
          speed,
          paused: request.stepping ?? false,
          ...(request.range ? { range: request.range } : {}),
        });
        if (request.stepping) await send({ type: 'playback/step' });
      })
      .catch(toast.error);
  };

  const run = (request: RunRequest = {}) => {
    const fields = variablesToPrompt(recording);
    if (fields.length > 0) setPrompt({ request, fields });
    else launch(request, {});
  };

  const submitPrompt = (values: Record<string, string>) => {
    if (!prompt) return;
    setPrompt(null);
    launch(prompt.request, values);
  };

  const changeSpeed = (value: number) => {
    setSpeed(value);
    command({ type: 'playback/speed', speed: value });
  };

  return { run, command, prompt, submitPrompt, cancelPrompt: () => setPrompt(null), speed, changeSpeed };
}
