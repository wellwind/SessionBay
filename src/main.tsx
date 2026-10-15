import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { startup } from './startup';
import { runSmokeInteraction } from './smoke';
window.SessionBaySmokeProbe = runSmokeInteraction;
startup.moduleLoaded();
ReactDOM.createRoot(document.getElementById('root')!, {
  onUncaughtError: startup.error,
}).render(<App />);
