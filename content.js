(function () {
  // Prevent double-injection
  if (window.__templaterLoaded) return;
  window.__templaterLoaded = true;

  let panel = null;

  function toggle() {
    if (panel) {
      panel.remove();
      panel = null;
    } else {
      show();
    }
  }

  function show() {
    panel = document.createElement('div');
    panel.id = '__templater-panel__';
    panel.style.cssText = [
      'position: fixed',
      'top: 60px',
      'right: 20px',
      'width: 480px',
      'height: 90vh',
      'max-height: 680px',
      'z-index: 2147483647',
      'border-radius: 12px',
      'box-shadow: 0 8px 40px rgba(0,0,0,0.5)',
      'border: 1px solid #2e2e4a',
      'overflow: hidden',
    ].join(';');

    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('popup.html');
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';

    panel.appendChild(iframe);
    document.documentElement.appendChild(panel);
  }

  // Close message sent from inside the iframe
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'templater-close') {
      if (panel) {
        panel.remove();
        panel = null;
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'templater-toggle') toggle();
  });

  // Show immediately on first inject
  show();
})();
