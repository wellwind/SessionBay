import { useEffect, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { api, isDesktop } from '../api';
import { t } from '../i18n';
import type { UpdateInfo } from '../types';

const DISMISSED_KEY = 'sessionbay.dismissedUpdate';
const FIRST_CHECK_MS = 5_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function dismissedVersion() {
  try { return localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

/** Shows a quiet notice when GitHub Releases has a newer version. Failures stay silent. */
export function UpdateNotice({ enabled }: { enabled: boolean }) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    if (!enabled || !isDesktop()) { setUpdate(null); return; }
    let cancelled = false;
    const check = () => void Promise.resolve().then(() => api.checkForUpdate()).then(found => {
      if (!cancelled) setUpdate(found && found.latest !== dismissedVersion() ? found : null);
    }, () => undefined);
    const first = setTimeout(check, FIRST_CHECK_MS);
    const daily = setInterval(check, CHECK_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(first); clearInterval(daily); };
  }, [enabled]);
  if (!update) return null;
  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, update.latest); } catch { /* the notice still closes */ }
    setUpdate(null);
  };
  return <div className="toast update-notice" role="status">
    <ArrowUpCircle size={17} aria-hidden="true" />
    <span>{t('Session Bay {{version}} is available.', { version: update.latest })}</span>
    <button className="secondary" onClick={() => void api.openReleasePage(update.url).catch(() => undefined)}>{t('View release')}</button>
    <button aria-label={t('Dismiss this version')} title={t('Dismiss this version')} onClick={dismiss}><X size={15} /></button>
  </div>;
}
