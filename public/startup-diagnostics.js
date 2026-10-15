/* Runs before the module graph, so missing chunks and import-time errors remain visible. */
(function () {
  'use strict';
  var failed = false;
  var ready = false;
  var reports = 0;
  function report(phase, message) {
    if (reports++ >= 32) return Promise.resolve(false);
    var detail = String(message).slice(0, 2048);
    var bridge = window.__TAURI_INTERNALS__;
    console[phase === 'error' ? 'error' : 'info']('[SessionBay startup] ' + phase + ': ' + detail);
    if (bridge && typeof bridge.invoke === 'function') {
      return bridge.invoke('frontend_diagnostic', { phase: phase, message: detail }).catch(function (error) {
        console.error('Session Bay startup diagnostic IPC failed:', error);
        return false;
      });
    }
    return Promise.resolve(false);
  }
  function error(message) {
    failed = true;
    document.documentElement.dataset.sessionbayReady = 'false';
    var detail = String(message).slice(0, 2048);
    report('error', detail);
    function show() {
      var status = document.getElementById('startup-status');
      if (status) {
        status.hidden = false;
        status.setAttribute('role', 'alert');
        status.textContent = 'Session Bay 啟動失敗。請重新啟動應用程式。\n' + detail;
      }
    }
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show, { once: true });
  }
  window.addEventListener('error', function (event) {
    var resource = event.target;
    if (resource && resource !== window && (resource.src || resource.href)) {
      error('Resource failed to load: ' + (resource.src || resource.href));
    } else {
      error((event.message || 'Uncaught JavaScript error') + ' at ' +
        (event.filename || 'unknown module') + ':' + (event.lineno || 0) + ':' + (event.colno || 0));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    error('Unhandled promise rejection: ' + (reason && reason.message ? reason.message : String(reason)));
  });
  document.addEventListener('securitypolicyviolation', function (event) {
    error('Content Security Policy blocked ' + event.violatedDirective + ': ' + event.blockedURI);
  });
  window.SessionBayStartup = {
    moduleLoaded: function () { report('module-loaded', 'Main module graph evaluated'); },
    mounted: function () {
      report('mounted', 'React app committed');
      var status = document.getElementById('startup-status');
      if (status && !failed) status.hidden = true;
    },
    error: error,
    // The app renders retry controls for bootstrap failures; do not cover or poison them.
    backendError: function (message) { report('error', 'Backend bootstrap failed: ' + message); },
    interaction: function () {
      if (!failed && ready) report('interaction', 'Settings dialog dismissed, reopened, closed, and reopened through live DOM clicks');
    },
    ready: function () {
      // Two animation frames follow the committed backend-ready DOM, not a fixed startup sleep.
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          if (failed || ready) return;
          var shell = document.querySelector('[data-app-shell][data-backend-ready="true"]');
          var header = shell && shell.querySelector('header');
          var bounds = shell && shell.getBoundingClientRect();
          if (!shell || !header || !header.textContent.includes('Session Bay') ||
              !bounds || bounds.width <= 0 || bounds.height <= 0) {
            error('Backend bootstrap completed, but the committed app shell is missing or has no layout');
            return;
          }
          ready = true;
          document.documentElement.dataset.sessionbayReady = 'true';
          report('ready', JSON.stringify({
            appReady: true,
            backendReady: true,
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
            buttons: shell.querySelectorAll('button').length,
            inputs: shell.querySelectorAll('input').length,
            onboardingVisible: !!document.querySelector('[role="dialog"]')
          })).then(function (smokeEnabled) {
            // Only a backend-confirmed opt-in may trigger the synthetic CI interaction.
            if (smokeEnabled === true && typeof window.SessionBaySmokeProbe === 'function') {
              return window.SessionBaySmokeProbe().catch(error);
            }
          });
        });
      });
    }
  };
  report('observer', 'Pre-module observer installed; ' + navigator.userAgent);
})();
