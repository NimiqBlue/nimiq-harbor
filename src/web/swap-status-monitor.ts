// Page-lifetime budgets survive Swap remounts/account reselection. Public reads only.
const budgets = new Map<string, { started: number; attempts: number; stopped: boolean }>();
export const STATUS_MONITOR_MAX_ATTEMPTS = 30;
export const STATUS_MONITOR_MAX_MS = 10 * 60_000;
export function monitorKey(account: string, request: string) { return `${account.toLowerCase()}:${request}`; }
export function createStatusMonitor(key: string, options: {
  now: () => number;
  visible: () => boolean;
  available: () => boolean;
  check: () => Promise<'pending' | 'stop' | 'paused'>;
  schedule: (work: () => void, delay: number) => () => void;
  exhausted?: () => void;
}) {
  let cancelled = false, running = false, cancelTimer: (() => void) | undefined;
  let budget = budgets.get(key);
  if (!budget && budgets.size < 100) { budget = { started: options.now(), attempts: 0, stopped: false }; budgets.set(key, budget); }
  const eligible = () => !cancelled && budget && !budget.stopped && budget.attempts < STATUS_MONITOR_MAX_ATTEMPTS && options.now() - budget.started < STATUS_MONITOR_MAX_MS;
  const queue = (delay: number) => { cancelTimer?.(); if (!eligible()) { if (!cancelled && !budget?.stopped) options.exhausted?.(); return; } if (options.visible()) cancelTimer = options.schedule(() => { void tick(); }, delay); };
  const tick = async () => {
    if (!eligible()) { queue(0); return; }
    if (running || !options.visible()) return;
    if (!options.available()) { queue(1000); return; }
    running = true; budget!.attempts++;
    let result: 'pending' | 'stop' | 'paused' = 'stop';
    try { result = await options.check(); } catch { /* Failure stops, never unbounded failure polling. */ }
    finally { running = false; }
    if (cancelled) return;
    if (result === 'stop') budget!.stopped = true;
    else queue(Math.min(30_000, 2000 * 2 ** Math.min(budget!.attempts - 1, 4)));
  };
  queue(0);
  return {
    visibilityChanged() { cancelTimer?.(); if (!running) queue(2000); },
    cancel() { cancelled = true; cancelTimer?.(); },
  };
}
