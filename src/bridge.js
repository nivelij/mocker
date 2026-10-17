// Isolated-world content script: relays rules from chrome.storage to inject.js,
// and request logs from inject.js back to the extension.
const RULES_EVENT = '__mocker:rules';
const GET_RULES_EVENT = '__mocker:get-rules';
const LOG_EVENT = '__mocker:log';
const MAX_LOG_ENTRIES = 200;
const isTopFrame = window === window.top;
const pageLog = [];

function safeSendMessage(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Extension was reloaded or removed; this content script is orphaned.
  }
}

async function pushRules() {
  const { enabled = true, rules = [] } = await chrome.storage.local.get(['enabled', 'rules']);
  document.dispatchEvent(new CustomEvent(RULES_EVENT, { detail: JSON.stringify({ enabled, rules }) }));
}

function remember(entry) {
  pageLog.push(entry);
  if (pageLog.length > MAX_LOG_ENTRIES) pageLog.shift();
}

document.addEventListener(GET_RULES_EVENT, pushRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.rules || changes.enabled)) pushRules();
});
pushRules();

document.addEventListener(LOG_EVENT, (event) => {
  let entry;
  try {
    entry = JSON.parse(event.detail);
  } catch {
    return;
  }
  if (isTopFrame) remember(entry);
  safeSendMessage({ type: 'log', entry });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isTopFrame) return;
  if (message.type === 'get-log') sendResponse(pageLog);
  if (message.type === 'frame-log') remember(message.entry);
  if (message.type === 'clear-log') pageLog.length = 0;
});

if (isTopFrame) safeSendMessage({ type: 'page-start' });
