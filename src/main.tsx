import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/noto-sans-tc/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource-variable/jetbrains-mono/wght-italic.css';
import './styles.css';
import './workbench.css';
import { loadBundledFonts } from './fonts';
import { startup } from './startup';
import { runSmokeInteraction } from './smoke';
import { call, isDesktop } from './api';
import { locale } from './i18n';
window.SessionBaySmokeProbe = runSmokeInteraction;
startup.moduleLoaded();
// The Rust core translates its own messages; tell it which language the UI uses.
if (isDesktop()) void call('set_locale', { locale: locale() }).catch(() => undefined);
void loadBundledFonts().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!, {
    onUncaughtError: startup.error,
  }).render(<App />);
});
