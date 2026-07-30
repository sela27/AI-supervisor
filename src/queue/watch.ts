import type { QueueEngine } from "./engine.js";
import { currentQueue, liveOutput, type LiveOutputView, type QueueView } from "./view.js";

/** Something worth telling a watcher about, in the shape it goes out in. */
export type QueueChange =
  | { event: "queue"; data: QueueView }
  | { event: "output"; data: LiveOutputView };

/**
 * How often the engine is looked at. A run mutates its state in place as it goes,
 * so this is what turns that into something a watcher can be sent. It is short
 * enough that a person never notices the lag and long enough that an idle night
 * costs nothing — and a state that came and went inside one tick is one no reader
 * could have seen anyway.
 */
const LOOK_EVERY_MS = 250;

/**
 * Watches one run on behalf of one reader, reporting the queue and the Attempt in
 * flight whenever either stops looking the way it last did. Answers how to stop —
 * a reader who has gone away must not leave the engine being read forever.
 */
export function watchQueue(
  engine: QueueEngine,
  onChange: (change: QueueChange) => void,
): () => void {
  const report = onlyWhenChanged(onChange);

  function look(): void {
    const queue = currentQueue(engine);
    report({ event: "queue", data: queue });
    report({ event: "output", data: liveOutput(engine, queue) });
  }

  // At once, so a reader who joins mid-run sees it rather than a blank page held
  // until the run's next move.
  look();
  const looking = setInterval(look, LOOK_EVERY_MS);
  // A watcher is never a reason for the process to stay up.
  looking.unref();

  return () => clearInterval(looking);
}

/**
 * Passes a change on only when it says something the last one of its kind did not.
 * A dashboard left open all night is one connection; repeating the same queue at
 * it four times a second until morning is the difference between live and noisy.
 */
function onlyWhenChanged(
  onChange: (change: QueueChange) => void,
): (change: QueueChange) => void {
  const reported = new Map<QueueChange["event"], string>();

  return (change) => {
    const said = JSON.stringify(change.data);
    if (reported.get(change.event) === said) return;
    reported.set(change.event, said);
    onChange(change);
  };
}
