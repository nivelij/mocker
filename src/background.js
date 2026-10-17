if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  chrome.action.setPopup({ popup: 'panel/panel.html' });
}
chrome.action.setBadgeBackgroundColor({ color: '#d9480f' });

// The badge text itself holds the per-tab mock count, since this worker's memory is wiped whenever
// Chrome idles it. Updates are chained so concurrent read-then-write increments don't drop counts.
let badgeUpdates = Promise.resolve();

function updateBadge(tabId, nextCount) {
  badgeUpdates = badgeUpdates
    .then(() => chrome.action.getBadgeText({ tabId }))
    .then((text) => {
      const count = nextCount(Number(text) || 0);
      return chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === 'page-start') updateBadge(tabId, () => 0);

  if (message.type === 'log') {
    if (sender.frameId !== 0) {
      chrome.tabs.sendMessage(tabId, { type: 'frame-log', entry: message.entry }, { frameId: 0 }).catch(() => {});
    }
    if (message.entry.mocked) updateBadge(tabId, (count) => count + 1);
  }
});
