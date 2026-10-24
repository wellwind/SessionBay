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
window.SessionBaySmokeProbe = runSmokeInteraction;
startup.moduleLoaded();
void loadBundledFonts().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!, {
    onUncaughtError: startup.error,
  }).render(<App />);
});
