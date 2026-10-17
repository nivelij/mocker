// Runs in the page's own JS world so it can replace window.fetch and XMLHttpRequest.
// It cannot touch chrome.* APIs; rules arrive from bridge.js as DOM events carrying JSON strings
// (strings are the only payload that crosses between the isolated and main worlds reliably).
(() => {
  const RULES_EVENT = '__mocker:rules';
  const GET_RULES_EVENT = '__mocker:get-rules';
  const LOG_EVENT = '__mocker:log';
  const MAX_LOGGED_BODY = 100_000;
  const RULES_WAIT_MS = 1500;

  let state = { enabled: false, rules: [] };
  let rulesLoaded = false;
  let markRulesLoaded;
  const rulesReady = new Promise((resolve) => (markRulesLoaded = resolve));
  // If the bridge never answers (e.g. extension reloaded under an open tab), don't hold requests forever.
  setTimeout(() => markRulesLoaded(), RULES_WAIT_MS);
  rulesReady.then(() => (rulesLoaded = true));

  document.addEventListener(RULES_EVENT, (event) => {
    try {
      state = JSON.parse(event.detail);
    } catch {
      return;
    }
    markRulesLoaded();
  });
  document.dispatchEvent(new CustomEvent(GET_RULES_EVENT));

  const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 205: 'Reset Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large',
    415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  const NULL_BODY_STATUSES = new Set([204, 205, 304]);

  // Mocks are scoped to the site shown in the address bar, so iframes use their top page's host.
  const pageSite = (() => {
    const ancestors = location.ancestorOrigins;
    try {
      return new URL(ancestors?.length ? ancestors[ancestors.length - 1] : location.href).hostname;
    } catch {
      return location.hostname;
    }
  })();

  function toAbsoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  }

  function urlMatches(rule, url) {
    switch (rule.matchType) {
      case 'exact':
        return url === rule.url;
      case 'regex':
        try {
          return new RegExp(rule.url).test(url);
        } catch {
          return false;
        }
      default:
        return url.includes(rule.url);
    }
  }

  function findRule(method, url) {
    if (!state.enabled) return null;
    return state.rules.find(
      (rule) =>
        rule.enabled &&
        rule.url &&
        (!rule.site || rule.site === pageSite) &&
        (rule.method === 'ANY' || rule.method === method) &&
        urlMatches(rule, url)
    );
  }

  function mockedResponse(rule) {
    const status = Number(rule.status) >= 200 && Number(rule.status) <= 599 ? Number(rule.status) : 200;
    const headers = new Map();
    for (const line of (rule.headers || '').split('\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return {
      status,
      statusText: STATUS_TEXT[status] || '',
      headers,
      body: NULL_BODY_STATUSES.has(status) ? null : rule.body || '',
    };
  }

  function waitForDelay(ms, signal) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }

  function truncate(text) {
    if (typeof text !== 'string') return null;
    return text.length > MAX_LOGGED_BODY ? text.slice(0, MAX_LOGGED_BODY) : text;
  }

  function isReadableText(contentType) {
    return /json|text|xml|javascript/i.test(contentType || '') && !/event-stream/i.test(contentType);
  }

  function log(entry) {
    document.dispatchEvent(
      new CustomEvent(LOG_EVENT, {
        detail: JSON.stringify({ id: crypto.randomUUID(), time: Date.now(), ...entry }),
      })
    );
  }

  // ---------- fetch ----------

  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    if (!rulesLoaded) await rulesReady;

    const request = input instanceof Request ? input : null;
    const url = toAbsoluteUrl(request ? request.url : input);
    const method = String(init?.method || request?.method || 'GET').toUpperCase();
    const rule = findRule(method, url);

    if (!rule) {
      const response = await originalFetch.call(window, input, init);
      if (state.enabled) logFetchResponse(method, url, response);
      return response;
    }

    const mock = mockedResponse(rule);
    const signal = init?.signal || request?.signal;
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    await waitForDelay(Number(rule.delayMs) || 0, signal);

    const response = new Response(mock.body, {
      status: mock.status,
      statusText: mock.statusText,
      headers: [...mock.headers],
    });
    Object.defineProperty(response, 'url', { value: url });
    log({ kind: 'fetch', method, url, status: mock.status, mocked: true, ruleId: rule.id, body: truncate(mock.body) });
    return response;
  };

  function logFetchResponse(method, url, response) {
    const contentType = response.headers.get('content-type');
    const entry = { kind: 'fetch', method, url, status: response.status, mocked: false, contentType, body: null };
    if (!isReadableText(contentType)) return log(entry);
    readStart(response.clone())
      .then((text) => log({ ...entry, body: text }))
      .catch(() => log(entry));
  }

  // Reads at most MAX_LOGGED_BODY characters so long-lived streams aren't buffered forever.
  async function readStart(response) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < MAX_LOGGED_BODY) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return text.slice(0, MAX_LOGGED_BODY);
  }

  // ---------- XMLHttpRequest ----------

  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  const requestInfo = new WeakMap();
  const MOCKED_XHR_PROPS = ['readyState', 'status', 'statusText', 'responseURL', 'responseText', 'response',
    'responseXML', 'getResponseHeader', 'getAllResponseHeaders', 'abort'];

  XHR.open = function (method, url, async) {
    for (const prop of MOCKED_XHR_PROPS) delete this[prop];
    requestInfo.set(this, {
      method: String(method).toUpperCase(),
      url: toAbsoluteUrl(url),
      async: arguments.length < 3 || async !== false,
    });
    return originalOpen.apply(this, arguments);
  };

  XHR.send = function () {
    const info = requestInfo.get(this);
    if (!info) return originalSend.apply(this, arguments);
    // A synchronous XHR can't wait for rules, so it uses whatever has arrived so far.
    if (rulesLoaded || !info.async) return sendOrMock(this, info, arguments);
    const args = arguments;
    rulesReady.then(() => {
      try {
        sendOrMock(this, info, args);
      } catch {
        // e.g. the page aborted the request while we were waiting for rules
      }
    });
  };

  function sendOrMock(xhr, info, args) {
    const rule = findRule(info.method, info.url);
    if (!rule) {
      if (state.enabled) xhr.addEventListener('loadend', () => logXhrResponse(xhr, info));
      return originalSend.apply(xhr, args);
    }
    mockXhr(xhr, info, rule);
  }

  function logXhrResponse(xhr, info) {
    const contentType = xhr.getResponseHeader('content-type');
    let body = null;
    if (isReadableText(contentType)) {
      if (xhr.responseType === '' || xhr.responseType === 'text') body = xhr.responseText;
      else if (xhr.responseType === 'json' && xhr.response != null) body = JSON.stringify(xhr.response);
    }
    log({ kind: 'xhr', method: info.method, url: info.url, status: xhr.status, mocked: false, contentType, body: truncate(body) });
  }

  function mockXhr(xhr, info, rule) {
    const mock = mockedResponse(rule);
    const text = mock.body ?? '';
    const contentType = mock.headers.get('content-type');
    let readyState = XMLHttpRequest.OPENED;
    let aborted = false;
    let timer;

    const responseFor = (type) => {
      switch (type) {
        case 'json':
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        case 'blob':
          return new Blob([text], { type: contentType });
        case 'arraybuffer':
          return new TextEncoder().encode(text).buffer;
        case 'document':
          return null;
        default:
          return text;
      }
    };

    const done = () => readyState === XMLHttpRequest.DONE;
    const define = (name, get) => Object.defineProperty(xhr, name, { configurable: true, get });
    define('readyState', () => readyState);
    define('status', () => (readyState >= XMLHttpRequest.HEADERS_RECEIVED && !aborted ? mock.status : 0));
    define('statusText', () => (readyState >= XMLHttpRequest.HEADERS_RECEIVED && !aborted ? mock.statusText : ''));
    define('responseURL', () => (readyState >= XMLHttpRequest.HEADERS_RECEIVED ? info.url : ''));
    define('responseText', () => (done() && !aborted ? text : ''));
    define('response', () => (done() && !aborted ? responseFor(xhr.responseType) : xhr.responseType ? null : ''));
    define('responseXML', () => null);
    Object.defineProperty(xhr, 'getResponseHeader', {
      configurable: true,
      value: (name) => (readyState >= XMLHttpRequest.HEADERS_RECEIVED ? mock.headers.get(String(name).toLowerCase()) ?? null : null),
    });
    Object.defineProperty(xhr, 'getAllResponseHeaders', {
      configurable: true,
      value: () =>
        readyState >= XMLHttpRequest.HEADERS_RECEIVED
          ? [...mock.headers].map(([name, value]) => `${name}: ${value}\r\n`).join('')
          : '',
    });
    Object.defineProperty(xhr, 'abort', {
      configurable: true,
      value: () => {
        if (aborted || done()) return;
        aborted = true;
        clearTimeout(timer);
        readyState = XMLHttpRequest.DONE;
        fire('readystatechange');
        readyState = XMLHttpRequest.UNSENT;
        fireProgress('abort', 0);
        fireProgress('loadend', 0);
      },
    });

    const fire = (type) => xhr.dispatchEvent(new Event(type));
    const fireProgress = (type, loaded) =>
      xhr.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded, total: loaded }));

    const complete = () => {
      if (aborted) return;
      readyState = XMLHttpRequest.HEADERS_RECEIVED;
      fire('readystatechange');
      readyState = XMLHttpRequest.LOADING;
      fire('readystatechange');
      fireProgress('progress', text.length);
      readyState = XMLHttpRequest.DONE;
      fire('readystatechange');
      fireProgress('load', text.length);
      fireProgress('loadend', text.length);
      log({ kind: 'xhr', method: info.method, url: info.url, status: mock.status, mocked: true, ruleId: rule.id, body: truncate(mock.body) });
    };

    if (!info.async) return complete();
    setTimeout(() => {
      if (aborted) return;
      fireProgress('loadstart', 0);
      timer = setTimeout(complete, Number(rule.delayMs) || 0);
    }, 0);
  }
})();
