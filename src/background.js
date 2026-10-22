chrome.action.onClicked.addListener(async (tab) => {
  // Can't inject into chrome://, new tab, or extension pages
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
    return;
  }

  try {
    // Content script already injected — just toggle
    await chrome.tabs.sendMessage(tab.id, { type: 'templater-toggle' });
  } catch {
    // First time — inject and let content.js open automatically
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content.js']
    });
  }
});
