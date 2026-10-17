const $ = (selector) => document.querySelector(selector);

const state = {
  enabled: true,
  rules: [],
  requests: [],
  tabId: null,
  host: '',
  view: 'mocks',
  editingId: null,
};

const form = $('#editor');

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

function statusBadge(status) {
  return el('span', { className: `status s${String(status)[0]}` }, String(status || '—'));
}

function prettyJson(text) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function urlMatches(rule, url) {
  if (!rule.url) return false;
  if (rule.matchType === 'exact') return url === rule.url;
  if (rule.matchType === 'regex') {
    try {
      return new RegExp(rule.url).test(url);
    } catch {
      return false;
    }
  }
  return url.includes(rule.url);
}

function withoutQuery(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

// Same method + URL without query = one row, ordered by most recent call.
function groupRequests(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.method} ${withoutQuery(entry.url)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()].sort((a, b) => b.at(-1).time - a.at(-1).time);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function appliesHere(rule) {
  return !rule.site || rule.site === state.host;
}

function describePattern(rule) {
  if (rule.matchType === 'regex') return `/${rule.url}/`;
  if (rule.matchType === 'exact') return `= ${rule.url}`;
  return rule.url;
}

// ---------- persistence ----------

async function loadSettings() {
  const { enabled = true, rules = [] } = await chrome.storage.local.get(['enabled', 'rules']);
  state.enabled = enabled;
  state.rules = rules;
  render();
}

function saveRules(rules) {
  state.rules = rules;
  render();
  return chrome.storage.local.set({ rules });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.rules) state.rules = changes.rules.newValue || [];
  if (changes.enabled) state.enabled = changes.enabled.newValue !== false;
  render();
});

// ---------- requests seen on the active tab ----------

async function refreshRequests() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  state.host = /^https?:/.test(tab?.url || '') ? hostOf(tab.url) : '';
  state.requests = [];
  if (state.tabId !== null) {
    try {
      state.requests = (await chrome.tabs.sendMessage(state.tabId, { type: 'get-log' }, { frameId: 0 })) || [];
    } catch {
      // No content script on this tab (chrome:// page, Web Store, or opened before the extension loaded).
    }
  }
  render();
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'log' || sender.tab?.id !== state.tabId) return;
  if (state.requests.some((entry) => entry.id === message.entry.id)) return;
  state.requests.push(message.entry);
  render();
});

chrome.tabs.onActivated.addListener(refreshRequests);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== state.tabId) return;
  if (change.status === 'loading') {
    state.requests = [];
    render();
  }
  if (change.status === 'complete') refreshRequests();
});

// ---------- rendering ----------

function render() {
  $('#enabled').checked = state.enabled;
  $('#enabled-label').textContent = state.enabled ? 'On' : 'Off';
  $('#mocks-count').textContent = state.rules.filter(appliesHere).length;
  $('#requests-count').textContent = groupRequests(state.requests).length;

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === state.view || (state.view === 'editor' && tab.dataset.view === 'mocks'));
  }
  $('#mocks-view').hidden = state.view !== 'mocks';
  $('#requests-view').hidden = state.view !== 'requests';
  $('#editor-view').hidden = state.view !== 'editor';

  renderRules();
  renderRequests();
  if (state.view === 'editor') updateUrlHint();
}

function renderRules() {
  const here = state.rules.filter(appliesHere);
  const elsewhere = state.rules.filter((rule) => !appliesHere(rule));

  $('#site-title').textContent = state.host ? `Active on ${state.host}` : 'Mocks for all sites';
  $('#rule-list').replaceChildren(...here.map(ruleItem));
  $('#rules-empty').hidden = here.length > 0;
  $('#rules-empty').textContent = state.host
    ? `No mocks for ${state.host} yet. Add one, or open Requests and click Mock on a call the page made.`
    : 'No mocks yet. Open a website, then add one or click Mock on a call in Requests.';

  const bySite = Map.groupBy(elsewhere, (rule) => rule.site);
  $('#other-sites').hidden = elsewhere.length === 0;
  $('#other-sites-title').textContent = `Other sites (${elsewhere.length})`;
  $('#other-sites-list').replaceChildren(
    ...[...bySite].flatMap(([site, rules]) => [
      el('h3', { className: 'section-title' }, site),
      el('ul', { className: 'list' }, ...rules.map(ruleItem)),
    ])
  );
}

function ruleItem(rule) {
  return el(
        'li',
        {
          className: `item rule-item${rule.enabled ? '' : ' off'}`,
          title: 'Click to edit',
          onclick: () => openEditor(rule),
        },
        el('input', {
          type: 'checkbox',
          checked: rule.enabled,
          title: rule.enabled ? 'Disable this mock' : 'Enable this mock',
          onclick: (event) => event.stopPropagation(),
          onchange: (event) => toggleRule(rule.id, event.target.checked),
        }),
        el('span', { className: 'method' }, rule.method),
        el(
          'div',
          { className: 'item-main' },
          rule.name ? el('div', { className: 'item-name' }, rule.name) : null,
          el('div', { className: 'item-url' }, describePattern(rule))
        ),
        !rule.site && state.host ? el('span', { className: 'tag neutral', title: 'Active on every site' }, 'ALL SITES') : null,
        statusBadge(rule.status)
      );
}

function renderRequests() {
  const filter = $('#request-filter').value.trim().toLowerCase();
  const visible = groupRequests(state.requests.filter((entry) => entry.url.toLowerCase().includes(filter)));

  $('#request-list').replaceChildren(
    ...visible.map((group) => {
      const entry = group.at(-1);
      const source = group.findLast((call) => !call.mocked) || entry;
      let host = '';
      let path = entry.url;
      try {
        const url = new URL(entry.url);
        host = url.host;
        path = url.pathname + url.search;
      } catch {}
      return el(
        'li',
        { className: 'item', title: group.length > 1 ? `${entry.url}\n${group.length} calls, latest shown` : entry.url },
        el('span', { className: 'method' }, entry.method),
        el(
          'div',
          { className: 'item-main' },
          el('div', { className: 'item-name' }, path),
          el('div', { className: 'item-url' }, host)
        ),
        group.length > 1 ? el('span', { className: 'repeat' }, `×${group.length}`) : null,
        entry.mocked ? el('span', { className: 'tag' }, 'MOCKED') : null,
        statusBadge(entry.status),
        el('button', { className: 'small', onclick: () => openEditorFromRequest(source) }, 'Mock')
      );
    })
  );
  $('#requests-empty').hidden = visible.length > 0;
  $('#requests-empty').textContent =
    state.requests.length && !visible.length
      ? 'Nothing matches the filter.'
      : 'No fetch/XHR calls seen on this tab yet. Reload the page to capture them.';
}

function toggleRule(id, enabled) {
  saveRules(state.rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule)));
}

// ---------- editor ----------

function openEditor(rule) {
  state.editingId = rule?.id ?? null;
  const values = {
    site: state.editingId ? '' : state.host,
    name: '',
    method: 'ANY',
    matchType: 'contains',
    url: '',
    status: 200,
    delayMs: 0,
    headers: '',
    body: '',
    ...rule,
  };
  const sites = [...new Set([state.host, values.site].filter(Boolean))];
  form.elements.site.replaceChildren(
    ...sites.map((site) => el('option', { value: site }, `Only ${site}`)),
    el('option', { value: '' }, 'All sites')
  );
  for (const [name, value] of Object.entries(values)) {
    if (form.elements[name]) form.elements[name].value = value;
  }
  $('#editor-title').textContent = state.editingId ? 'Edit mock' : 'New mock';
  $('#delete-rule').hidden = !state.editingId;
  state.view = 'editor';
  render();
  updateBodyStatus();
  form.elements.url.focus();
}

function openEditorFromRequest(entry) {
  openEditor({
    method: entry.method,
    url: withoutQuery(entry.url),
    status: entry.status >= 200 && entry.status <= 599 ? entry.status : 200,
    body: prettyJson(entry.body),
  });
}

function closeEditor() {
  state.editingId = null;
  state.view = 'mocks';
  render();
}

function readForm() {
  const data = Object.fromEntries(new FormData(form));
  return {
    site: data.site,
    name: data.name.trim(),
    method: data.method,
    matchType: data.matchType,
    url: data.url.trim(),
    status: Number(data.status),
    delayMs: Math.max(0, Number(data.delayMs) || 0),
    headers: data.headers,
    body: data.body,
  };
}

function updateUrlHint() {
  const hint = $('#url-hint');
  const draft = readForm();
  hint.classList.remove('bad');
  if (!draft.url) return (hint.textContent = '');
  if (draft.matchType === 'regex') {
    try {
      new RegExp(draft.url);
    } catch (error) {
      hint.classList.add('bad');
      return (hint.textContent = `Invalid regex: ${error.message}`);
    }
  }
  if (!appliesHere(draft)) return (hint.textContent = `Not active on ${state.host || 'this page'}.`);
  if (!state.requests.length) return (hint.textContent = '');
  const matches = state.requests.filter(
    (entry) => (draft.method === 'ANY' || draft.method === entry.method) && urlMatches(draft, entry.url)
  ).length;
  hint.textContent = matches
    ? `Matches ${matches} of the ${state.requests.length} requests seen on this tab.`
    : `Matches none of the ${state.requests.length} requests seen on this tab.`;
}

function updateBodyStatus() {
  const body = form.elements.body;
  const status = $('#body-status');
  let valid = true;
  if (body.value.trim()) {
    try {
      JSON.parse(body.value);
    } catch {
      valid = false;
    }
  }
  body.classList.toggle('invalid', !valid);
  status.classList.toggle('bad', !valid);
  status.textContent = !body.value.trim() ? '' : valid ? 'Valid JSON' : 'Not valid JSON — will be sent as-is';
}

form.addEventListener('input', (event) => {
  if (event.target.name === 'body') updateBodyStatus();
  else updateUrlHint();
});
form.addEventListener('change', updateUrlHint);

$('#format-body').addEventListener('click', () => {
  const body = form.elements.body;
  try {
    body.value = JSON.stringify(JSON.parse(body.value), null, 2);
  } catch {}
  updateBodyStatus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const draft = readForm();
  if (draft.matchType === 'regex') {
    try {
      new RegExp(draft.url);
    } catch {
      form.elements.url.focus();
      return;
    }
  }
  const rules = state.editingId
    ? state.rules.map((rule) => (rule.id === state.editingId ? { ...rule, ...draft } : rule))
    : [...state.rules, { id: crypto.randomUUID(), enabled: true, ...draft }];
  closeEditor();
  await saveRules(rules);
});

$('#cancel-edit').addEventListener('click', closeEditor);

$('#delete-rule').addEventListener('click', async () => {
  const id = state.editingId;
  closeEditor();
  await saveRules(state.rules.filter((rule) => rule.id !== id));
});

// ---------- top-level controls ----------

$('#enabled').addEventListener('change', (event) => {
  state.enabled = event.target.checked;
  render();
  chrome.storage.local.set({ enabled: state.enabled });
});

$('#tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  state.view = tab.dataset.view;
  state.editingId = null;
  render();
});

$('#add-mock').addEventListener('click', () => openEditor());
$('#request-filter').addEventListener('input', renderRequests);
$('#clear-requests').addEventListener('click', () => {
  state.requests = [];
  render();
  if (state.tabId !== null) chrome.tabs.sendMessage(state.tabId, { type: 'clear-log' }, { frameId: 0 }).catch(() => {});
});

loadSettings();
refreshRequests();
