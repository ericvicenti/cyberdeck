import { useCallback, useEffect, useState } from 'react';
import { useRuntime } from '@remote/runtime';

/** Loads the signed server's execution state and makes delivery/synchronization failures visible. */
export function useAgentWorkspace() {
  const { connection } = useRuntime();
  const [workspace, setWorkspace] = useState<any>();
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(0);
  const request = useCallback(async (route: string, body?: unknown) => {
    if (!connection) throw new Error('Not connected to Cyberdeck');
    const response = await connection.request(`/api/seed/${route}`, body === undefined ? undefined : { method: 'POST', signal: AbortSignal.timeout(300000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `Server HTTP ${response.status}`);
    return result;
  }, [connection]);
  const refresh = useCallback(async () => { const value = await request('workspace'); setWorkspace(value); setLastSync(Date.now()); setError(''); return value; }, [request]);
  useEffect(() => {
    let mounted = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { await refresh(); } catch (cause) { if (mounted) setError(String(cause)); } finally { if (mounted) timer = setTimeout(poll, 1200); } };
    void poll(); return () => { mounted = false; clearTimeout(timer); };
  }, [refresh]);
  return { workspace, error, lastSync, request, refresh };
}
