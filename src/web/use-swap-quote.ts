import { useEffect, useRef, useState } from 'react';
import { getFusionQuote, fusionUnavailable, type FusionPreview, type FusionQuoteRequest } from './fusion';

// Also serialize across Swap unmount/remount when switching Harbor tabs.
let physicalBusy = false;
const settledListeners = new Set<() => void>();

/** One physical request at a time. Successful quotes alone arm expiry refresh.
 * Same-intent old quotes are display-only; callers must gate review on freshness.
 */
export function useSwapQuote(request: FusionQuoteRequest | null, paused: boolean, selection: number) {
  const key = JSON.stringify({ request, selection });
  const latest = useRef({ key, request, paused }); latest.current = { key, request, paused };
  const flight = useRef(false);
  const lastStart = useRef(0);
  const epoch = useRef(0);
  const failedKeys = useRef(new Set<string>());
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const [state, setState] = useState<{ key: string; quote: FusionPreview | null; error: string; busy: boolean }>({ key: '', quote: null, error: '', busy: false });
  useEffect(() => {
    const settled = () => setRevision(r => r + 1);
    settledListeners.add(settled);
    const change = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', change);
    return () => { epoch.current++; settledListeners.delete(settled); document.removeEventListener('visibilitychange', change); };
  }, []);
  // Increment even for edits away and back; a late response cannot revive evidence.
  useEffect(() => { epoch.current++; setState({ key, quote: null, error: '', busy: false }); }, [key]);
  const run = async () => {
    const current = latest.current;
    if (physicalBusy || flight.current || !current.request || current.paused || document.visibilityState !== 'visible') return;
    physicalBusy = true; flight.current = true; lastStart.current = Date.now();
    const version = epoch.current;
    setState(s => ({ key: current.key, quote: s.key === current.key ? s.quote : null, error: '', busy: true }));
    try {
      const quote = await getFusionQuote(current.request);
      if (epoch.current === version && latest.current.key === current.key) setState({ key: current.key, quote, error: '', busy: false });
    } catch (error) {
      failedKeys.current.add(current.key);
      if (epoch.current === version && latest.current.key === current.key) setState(s => ({ ...s, busy: false, error: fusionUnavailable(error) }));
    } finally {
      physicalBusy = false; flight.current = false; settledListeners.forEach(listener => listener());
    }
  };
  const runRef = useRef(run); runRef.current = run;
  useEffect(() => {
    if (!request || paused || !visible || physicalBusy || flight.current) return;
    const current = state.key === key ? state : null;
    if (current?.error || failedKeys.current.has(key)) return; // No automatic retry, even after wallet visibility revalidation.
    const delay = current?.quote
      ? Math.max(0, current.quote.expiresAt - 5000 - Date.now(), lastStart.current + 30000 - Date.now())
      : 800;
    const timer = setTimeout(() => void runRef.current(), delay);
    return () => clearTimeout(timer);
  }, [key, request, paused, visible, state, revision]);
  return { quote: state.key === key ? state.quote : null, busy: state.key === key && state.busy, error: state.key === key ? state.error || (failedKeys.current.has(key) ? fusionUnavailable(null) : '') : '', refresh: () => { failedKeys.current.delete(key); void runRef.current(); } };
}
