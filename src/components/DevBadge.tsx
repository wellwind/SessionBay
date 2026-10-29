import { devBranch, devCommit, isDevBuild } from '../app-identity';
import { t } from '../i18n';

export function DevBadge() {
  if (!isDevBuild) return null;
  const description = t('Development build · branch: {{branch}} · commit: {{commit}}', {
    branch: devBranch || t('Unknown'),
    commit: devCommit || t('Unknown'),
  });
  return <span className="dev-badge" tabIndex={0} title={description} aria-label={description}>{t('DEV')}</span>;
}
