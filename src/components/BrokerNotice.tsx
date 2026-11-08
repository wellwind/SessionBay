import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import type { BrokerStatus } from '../types';

export function BrokerNotice({ enabled, onRestart }: {
  enabled: boolean;
  onRestart: (status: BrokerStatus) => void;
}) {
  const [status, setStatus] = useState<BrokerStatus>();
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.backgroundServiceStatus();
        if (!disposed) setStatus(next);
      } catch {
        // Keep a known mismatch visible during reconnect. Bootstrap reports
        // connection failures; this maintenance poll retries without toast spam.
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [enabled]);
  if (!enabled || !status?.buildMismatch) return null;
  return <div className="project-warning broker-notice" role="status">
    <AlertTriangle size={17} aria-hidden="true" />
    <span>{t('The background service is from another version. {{count}} agents are running. New agents still use the old launch logic. It updates automatically once all running agents end, if supported by this service. Older services require a confirmed restart.', { count: status.runningCount })}</span>
    <button onClick={() => onRestart(status)}>{t('Restart background service')}</button>
  </div>;
}
