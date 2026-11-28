/**
 * Busy-input queue semantics, extracted as a pure reducer so the REPL only
 * wires keys and rendering. Natural turn end (and the idle empty-Enter
 * resume) shift the head as the next submit; cancel and error freeze the
 * queue (nothing auto-fires); Esc at idle clears it.
 */

export type QueueAction =
  | { type: 'enqueue'; text: string }
  | { type: 'turnEnded' }
  | { type: 'frozen' }
  | { type: 'submitNext' }
  | { type: 'clear' };

export interface QueueState {
  queue: string[];
  submit?: string;
}

export function reduceQueue(queue: string[], action: QueueAction): QueueState {
  switch (action.type) {
    case 'enqueue': {
      const text = action.text.trim();
      if (!text) return { queue };
      return { queue: [...queue, text] };
    }
    case 'turnEnded':
    case 'submitNext': {
      // Same-reference returns on empty/frozen are a CONTRACT: the useReducer
      // call site bails out of re-rendering on reference equality, keeping
      // idle Enter-presses from thrashing the queue commit.
      if (queue.length === 0) return { queue };
      return { queue: queue.slice(1), submit: queue[0] };
    }
    case 'frozen':
      // Frozen keeps the SAME reference: nothing shifted, nothing to render.
      return { queue };
    case 'clear':
      return { queue: [] };
  }
}

/**
 * Empty-Enter resumes the queue ONLY at the idle prompt: the apikey phases
 * have their own empty-Enter contract ("reuse the saved key"), and routing
 * their Enter to the queue would swallow a queued prompt as if it were a key.
 */
export function shouldResumeQueue(phase: string, raw: string, queueLength: number): boolean {
  return phase === 'idle' && !raw.trim() && queueLength > 0;
}
