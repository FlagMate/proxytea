/* Super Debug SDK — live demo controller (vanilla JS, no framework). */
(function () {
  'use strict';

  // Capture the PRISTINE fetch before the SDK patches window.fetch, so we can
  // always show the true "before" (original API) response for comparison.
  var ORIGINAL_FETCH = window.fetch.bind(window);

  var $ = function (id) { return document.getElementById(id); };

  function getServerUrl() {
    var q = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : null;
    if (q && (q.get('server') || q.get('backend') || q.get('api'))) {
      return (q.get('server') || q.get('backend') || q.get('api')).replace(/\/+$/, '');
    }
    if (window.SuperDebug) {
      if (typeof window.SuperDebug.getServerUrl === 'function') return window.SuperDebug.getServerUrl();
      if (window.SuperDebug.DEFAULT_SERVER_URL) return window.SuperDebug.DEFAULT_SERVER_URL;
    }
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      return window.location.origin;
    }
    return '';
  }

  var state = {
    connected: false,
    server: getServerUrl(),
    apiKey: '',
    cloudRules: [],          // full list from cloud (incl. disabled)
    localDisabled: {},       // ruleId -> true (per-rule off in the demo)
    master: true,            // global switch
    pollTimer: null,
    lastSig: '',             // signature of cloud rules to detect changes
  };

  // ---- Effective rules pushed into the SDK -------------------------------
  function computeEffective() {
    if (!state.master) return [];
    return state.cloudRules.filter(function (r) {
      if (state.localDisabled[r.id]) return false;
      // Respect the cloud rule's own enabled flag as the default.
      return r.enabled !== false;
    });
  }

  function applyToSdk() {
    if (window.SuperDebug) window.SuperDebug.setRules(computeEffective());
  }

  // ---- Rule action classification (for tags + log) -----------------------
  function ruleActions(r) {
    var out = [];
    if (r.block) out.push('block');
    var req = r.request || {}, res = r.response || {};
    if (req.redirectUrl) out.push('redirect');
    if (req.urlRewrite && req.urlRewrite.find) out.push('rewrite');
    if ((res.headers && res.headers.length) || (req.headers && req.headers.length)) out.push('headers');
    if (res.body && res.body.enabled) out.push('mock');
    if (req.body && req.body.enabled) out.push('mock');
    if (typeof req.delay === 'number' && req.delay > 0) out.push('delay');
    return out.length ? out : ['headers'];
  }

  function ruleSummary(r) {
    var m = r.match || {};
    var pattern = m.urlPattern || '*';
    var methods = (m.methods && m.methods.join('/')) || '*';
    return methods + '  ' + pattern;
  }

  // ---- Render rules ------------------------------------------------------
  function renderRules() {
    var list = $('rules-list');
    list.className = 'rules-list' + (state.master ? '' : ' dimmed');
    if (!state.cloudRules.length) {
      list.innerHTML = '<div class="empty">No rules yet. Create one in the dashboard and hit “Sync now”.</div>';
      return;
    }
    list.innerHTML = '';
    state.cloudRules.forEach(function (r) {
      var on = !state.localDisabled[r.id] && r.enabled !== false;
      var row = document.createElement('div');
      row.className = 'rule' + (on ? '' : ' off');

      var tags = ruleActions(r).map(function (a) {
        return '<span class="tag ' + a + '">' + a + '</span>';
      }).join(' ');

      row.innerHTML =
        '<div class="r-main">' +
          '<div class="r-name">' + escapeHtml(r.name) + ' ' + tags +
            (r.enabled === false ? ' <span class="tag" style="color:var(--faint);border-color:var(--border)">disabled in cloud</span>' : '') +
          '</div>' +
          '<div class="r-desc">' + escapeHtml(ruleSummary(r)) + '</div>' +
        '</div>';

      var sw = document.createElement('label');
      sw.className = 'switch';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.disabled = r.enabled === false; // can't enable a cloud-disabled rule locally
      cb.addEventListener('change', function () {
        if (cb.checked) delete state.localDisabled[r.id];
        else state.localDisabled[r.id] = true;
        applyToSdk();
        renderRules();
        addLog('info', (cb.checked ? 'Enabled' : 'Disabled') + ' rule locally: ' + r.name, '');
      });
      var slider = document.createElement('span');
      slider.className = 'slider';
      sw.appendChild(cb); sw.appendChild(slider);
      row.appendChild(sw);
      list.appendChild(row);
    });
  }

  // ---- Cloud sync --------------------------------------------------------
  function syncRules(showToast) {
    var base = state.server.replace(/\/+$/, '');
    return ORIGINAL_FETCH(base + '/public/rules?includeDisabled=1', {
      headers: { 'X-API-Key': state.apiKey },
      cache: 'no-store',
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        var rules = (json && json.data && json.data.rules) || [];
        var sig = JSON.stringify(rules.map(function (x) { return [x.id, x.name, x.enabled, x.updatedAt]; }));
        var changed = sig !== state.lastSig;
        state.lastSig = sig;
        state.cloudRules = rules;
        applyToSdk();
        renderRules();
        if (changed && state.connected) {
          setStep('step-rules', 'done');
          if (showToast !== false) addLog('sync', 'Synced ' + rules.length + ' rule(s) from cloud', 'applied');
        }
        return rules;
      })
      .catch(function (e) {
        addLog('sync', 'Sync failed: ' + e.message, 'blocked');
        throw e;
      });
  }

  // ---- Connect -----------------------------------------------------------
  function connect() {
    var keyInput = $('apikey');
    var apiKey = keyInput ? keyInput.value.trim() : '';
    var msg = $('connect-msg');
    if (!apiKey) {
      msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'Enter your API key to start.';
      return;
    }
    // Guard against pasted bullet characters / masked inputs
    if (/[\u2022\u25cf\u22c5]/.test(apiKey)) {
      msg.hidden = false; msg.className = 'msg err';
      msg.textContent = 'API key contains masked bullets (•••). Please reveal and copy the full key from Workspace Settings → API Keys.';
      return;
    }
    apiKey = apiKey.replace(/[^\x20-\x7E]/g, '');

    var server = state.server || getServerUrl();
    state.apiKey = apiKey;
    state.server = server;
    $('connect-btn').disabled = true;
    $('connect-btn').textContent = 'Connecting…';

    // Verify the key first (nice error if wrong), then init the real SDK.
    ORIGINAL_FETCH(server.replace(/\/+$/, '') + '/public/verify', {
      headers: { 'X-API-Key': apiKey }, cache: 'no-store',
    })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 401 ? 'Invalid or revoked API key' : 'HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        var ws = json && json.data && json.data.workspace;
        // Init the real SDK. Pre-baked server URL in SDK is used automatically!
        window.SuperDebug.init({ apiKey: apiKey, refreshInterval: 0, debug: true });
        state.connected = true;
        setConn(true, ws ? ws.name : 'connected');
        msg.hidden = false; msg.className = 'msg ok';
        msg.textContent = 'Connected to “' + (ws ? ws.name : 'workspace') + '”. Rules are now syncing live.';
        setStep('step-connect', 'done');
        setStep('step-rules', 'active');
        $('workflow').hidden = false;
        return syncRules(false);
      })
      .then(function () {
        // Start live polling every 300s (mirrors the SDK's default refreshInterval).
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = setInterval(function () { syncRules(true).catch(function () {}); }, 300000);
      })
      .catch(function (e) {
        msg.hidden = false; msg.className = 'msg err'; msg.textContent = 'Could not connect: ' + e.message;
        setConn(false);
      })
      .then(function () {
        $('connect-btn').disabled = false;
        $('connect-btn').textContent = 'Connect & start';
      });
  }

  // ---- 10 Preset Examples (4.1 to 4.10) -----------------------------------
  var EXAMPLES = [
    {
      id: '4.1',
      title: 'GET Basic Request',
      method: 'GET',
      desc: 'Simple baseline GET request without custom headers or payload',
      url: 'https://jsonplaceholder.typicode.com/todos/1',
      headers: null,
      body: null,
      chips: ['GET', 'No Headers', 'No Payload']
    },
    {
      id: '4.2',
      title: 'GET with Custom Headers',
      method: 'GET',
      desc: 'GET request with Authorization Bearer and custom diagnostic headers',
      url: 'https://jsonplaceholder.typicode.com/users/1',
      headers: {
        'Authorization': 'Bearer sdm_live_sample_token_xyz',
        'X-Client-Version': '2.4.0',
        'Accept': 'application/json'
      },
      body: null,
      chips: ['GET', '+Headers', 'No Payload']
    },
    {
      id: '4.3',
      title: 'POST with JSON Payload',
      method: 'POST',
      desc: 'POST sending JSON body with default Content-Type header',
      url: 'https://jsonplaceholder.typicode.com/posts',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: 'Super Debug Test Post',
        body: 'Testing proxy interception with JSON payload',
        userId: 1
      }, null, 2),
      chips: ['POST', '+JSON Payload']
    },
    {
      id: '4.4',
      title: 'POST with Payload & Headers',
      method: 'POST',
      desc: 'POST combining JSON body with custom auth and trace headers',
      url: 'https://jsonplaceholder.typicode.com/comments',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sdm_live_auth_sample_token',
        'X-Request-Source': 'ProxyTea-SDK',
        'X-Trace-Id': 'trace-88219'
      },
      body: JSON.stringify({
        postId: 1,
        name: 'QA Automation Bot',
        email: 'qa@proxytea.dev',
        body: 'Verifying payload interception and custom headers simultaneously.'
      }, null, 2),
      chips: ['POST', '+Headers', '+Payload']
    },
    {
      id: '4.5',
      title: 'GET with Query & Cache Headers',
      method: 'GET',
      desc: 'GET query filter with explicit Cache-Control and Pragma headers',
      url: 'https://jsonplaceholder.typicode.com/comments?postId=1&limit=5',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      },
      body: null,
      chips: ['GET', '+Query', '+Headers']
    },
    {
      id: '4.6',
      title: 'POST with Form URL-Encoded',
      method: 'POST',
      desc: 'POST with application/x-www-form-urlencoded form string payload',
      url: 'https://jsonplaceholder.typicode.com/posts',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'title=Form+Encoded+Article&body=Testing+form+urlencoded+body+format&userId=42',
      chips: ['POST', '+Form Body', '+Headers']
    },
    {
      id: '4.7',
      title: 'POST with Entity Update Payload',
      method: 'POST',
      desc: 'POST entity update payload with conditional headers and API version tag',
      url: 'https://jsonplaceholder.typicode.com/posts',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Version': 'v2.4',
        'If-Match': '"e0384a2f"'
      },
      body: JSON.stringify({
        id: 101,
        title: 'Updated Post via POST',
        body: 'Overwriting existing entity payload with modified fields',
        userId: 1
      }, null, 2),
      chips: ['POST', '+Version Header', '+Payload']
    },
    {
      id: '4.8',
      title: 'POST with Nested JSON & Trace',
      method: 'POST',
      desc: 'POST with multi-level nested JSON object and correlation ID header',
      url: 'https://jsonplaceholder.typicode.com/posts',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': 'corr-uuid-9482'
      },
      body: JSON.stringify({
        session: {
          id: 'sess_live_99',
          user: {
            id: 101,
            roles: ['developer', 'admin'],
            preferences: { theme: 'dark', debug: true }
          }
        },
        action: 'deep_merge_verify'
      }, null, 2),
      chips: ['POST', '+Nested JSON', '+Trace ID']
    },
    {
      id: '4.9',
      title: 'GET with Accept Headers',
      method: 'GET',
      desc: 'GET content negotiation testing Accept and Accept-Language headers',
      url: 'https://jsonplaceholder.typicode.com/albums/1',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-App-Env': 'staging'
      },
      body: null,
      chips: ['GET', '+Accept Headers']
    },
    {
      id: '4.10',
      title: 'POST Batch Telemetry & Device Headers',
      method: 'POST',
      desc: 'POST array of telemetry events with device platform headers',
      url: 'https://jsonplaceholder.typicode.com/posts',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Platform': 'SmartTV_Tizen',
        'X-SDK-Version': '1.0.2'
      },
      body: JSON.stringify({
        events: [
          { type: 'player_init', ts: 1726912340 },
          { type: 'vst_start', vst_ms: 420 },
          { type: 'first_frame_rendered', bitrate_kbps: 4500 }
        ]
      }, null, 2),
      chips: ['POST', '+Batch Array', '+Device Headers']
    }
  ];

  function renderExamplesGrid() {
    var grid = $('examples-grid');
    if (!grid) return;
    grid.innerHTML = '';
    EXAMPLES.forEach(function (ex) {
      var card = document.createElement('div');
      var isAct = state.selectedExampleId === ex.id;
      card.className = 'ex-card' + (isAct ? ' active' : '');
      card.dataset.id = ex.id;

      var chipsHtml = (ex.chips || []).map(function (c) {
        var isHigh = c.indexOf('+') === 0;
        return '<span class="ex-chip' + (isHigh ? ' highlight' : '') + '">' + escapeHtml(c) + '</span>';
      }).join('');

      card.innerHTML =
        '<div class="ex-top">' +
          '<span class="ex-badge">' + ex.id + '</span>' +
          '<span class="ex-method ' + ex.method.toLowerCase() + '">' + ex.method + '</span>' +
        '</div>' +
        '<div class="ex-title" title="' + escapeHtml(ex.title) + '">' + escapeHtml(ex.title) + '</div>' +
        '<div class="ex-chips">' + chipsHtml + '</div>';

      card.addEventListener('click', function () {
        selectExample(ex.id);
      });
      grid.appendChild(card);
    });
  }

  function selectExample(id) {
    state.selectedExampleId = id;
    var ex = EXAMPLES.find(function (e) { return e.id === id; }) || EXAMPLES[0];
    loadExample(ex);

    var cards = document.querySelectorAll('.ex-card');
    cards.forEach(function (c) {
      if (c.dataset.id === id) c.classList.add('active');
      else c.classList.remove('active');
    });
  }

  function loadExample(ex) {
    if (!ex) return;
    $('req-url').value = ex.url;
    $('req-method').value = ex.method;
    $('req-method').disabled = true; // Method cannot be changed!
    $('active-ex-num').textContent = ex.id;
    $('active-ex-title').textContent = ex.title;
    $('active-ex-desc').textContent = ex.desc;

    // Headers inspection
    var headPre = $('meta-headers');
    var headBadge = $('meta-headers-count');
    if (ex.headers && Object.keys(ex.headers).length > 0) {
      headPre.textContent = JSON.stringify(ex.headers, null, 2);
      headBadge.textContent = Object.keys(ex.headers).length + ' set';
      headBadge.style.color = 'var(--accent-bright)';
    } else {
      headPre.textContent = '(None)';
      headBadge.textContent = 'None';
      headBadge.style.color = '';
    }

    // Payload inspection
    var bodyPre = $('meta-body');
    var bodyBadge = $('meta-body-badge');
    if (ex.body) {
      bodyPre.textContent = ex.body;
      bodyBadge.textContent = ex.method === 'POST' && ex.body.indexOf('{') === 0 ? 'JSON' : 'Form/Text';
      bodyBadge.style.color = 'var(--accent-bright)';
    } else {
      bodyPre.textContent = '(None)';
      bodyBadge.textContent = 'None';
      bodyBadge.style.color = '';
    }
  }

  // ---- Run a single request -----------------------------------------------
  function runRequest() {
    var ex = EXAMPLES.find(function (e) { return e.id === state.selectedExampleId; }) || EXAMPLES[0];
    var url = $('req-url').value.trim() || ex.url;
    var method = ex.method; // Fixed method
    var transport = $('req-transport').value; // 'fetch' | 'xhr' (user selectable)
    var headers = ex.headers;
    var body = ex.body;
    if (!url) return;

    setStep('step-run', 'done');

    // Label the pane
    $('resp-mode').className = 'dot green';
    $('resp-label').textContent = 'Response';
    $('resp-meta').textContent = 'sending…';
    $('resp').textContent = '…';

    var run;
    if (transport === 'xhr') {
      run = doXhr(url, method, headers, body);                     // patched XHR
    } else {
      run = doRequest(window.fetch, url, method, headers, body);   // patched fetch
    }

    run.then(function (r) {
      $('resp-meta').textContent = r.status + ' · ' + r.bytes + ' bytes' + (r.ms != null ? ' · ' + r.ms + 'ms' : '') + ' [' + transport + ']';
      $('resp').textContent = pretty(r.body);
      addLog(method + ' [' + transport + ']', url, String(r.status));
    }).catch(function (e) {
      $('resp-meta').textContent = 'error [' + transport + ']';
      $('resp').textContent = String(e && e.message || e);
      addLog(method + ' [' + transport + ']', url, 'error');
    });
  }

  function doRequest(fetchFn, url, method, headers, body) {
    var t0 = performance.now();
    var opts = { method: method };
    if (headers && Object.keys(headers).length > 0) {
      opts.headers = headers;
    }
    if (body && method !== 'GET' && method !== 'HEAD') {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetchFn(url, opts).then(function (res) {
      return res.text().then(function (resBody) {
        return { status: res.status, bytes: resBody.length, body: resBody, ms: Math.round(performance.now() - t0) };
      });
    });
  }

  function doXhr(url, method, headers, body) {
    return new Promise(function (resolve, reject) {
      var t0 = performance.now();
      var x = new XMLHttpRequest();
      x.open(method, url);
      if (headers) {
        Object.keys(headers).forEach(function (k) {
          try { x.setRequestHeader(k, headers[k]); } catch (e) {}
        });
      }
      x.onreadystatechange = function () {
        if (x.readyState === 4) {
          if (x.status === 0) return reject(new Error('Blocked by Super Debug SDK rule'));
          resolve({ status: x.status, bytes: (x.responseText || '').length, body: x.responseText, ms: Math.round(performance.now() - t0) });
        }
      };
      x.onerror = function () { reject(new Error('Blocked by Super Debug SDK rule')); };
      var sendData = (body && method !== 'GET' && method !== 'HEAD')
        ? (typeof body === 'string' ? body : JSON.stringify(body))
        : null;
      x.send(sendData);
    });
  }

  // ---- UI helpers --------------------------------------------------------
  function setConn(ok, label) {
    var pill = $('conn-pill');
    pill.className = 'pill ' + (ok ? 'ok' : 'err');
    pill.textContent = ok ? ('Connected · ' + label) : 'Connection failed';
  }
  function setStep(id, cls) {
    var el = $(id);
    if (el) el.className = 'step ' + cls;
  }
  function addLog(method, url, status) {
    var log = $('log');
    var empty = log.querySelector('.log-empty');
    if (empty) empty.remove();
    var row = document.createElement('div');
    row.className = 'log-row';
    var time = new Date().toLocaleTimeString();
    var statusClass = 'passthrough';
    if (/^2/.test(status) || status === 'applied') statusClass = 'applied';
    else if (/^[45]/.test(status) || status === 'blocked' || status === 'error') statusClass = 'blocked';
    row.innerHTML =
      '<span class="t">' + time + '</span>' +
      '<span class="m">' + escapeHtml(method) + '</span>' +
      '<span class="u">' + escapeHtml(url) + '</span>' +
      (status ? '<span class="s ' + statusClass + '">' + escapeHtml(status) + '</span>' : '');
    log.insertBefore(row, log.firstChild);
  }
  function pretty(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- Wire up -----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    $('connect-btn').addEventListener('click', connect);
    $('apikey').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
    $('sync-btn').addEventListener('click', function () { syncRules(true).catch(function () {}); });
    $('run-btn').addEventListener('click', runRequest);
    $('clear-log').addEventListener('click', function () {
      $('log').innerHTML = '<div class="log-empty muted">Requests you send will be logged here.</div>';
    });
    $('master-toggle').addEventListener('change', function (e) {
      state.master = e.target.checked;
      applyToSdk();
      renderRules();
      $('sync-note').textContent = state.master ? 'auto-syncing every 5s' : 'ALL RULES DISABLED (master off)';
      addLog('info', state.master ? 'Master switch ON — rules active' : 'Master switch OFF — all rules disabled', state.master ? 'applied' : 'blocked');
    });

    // Auto-populate API key if provided in query params (?key= or ?apiKey= or ?api_key=)
    var q = new URLSearchParams(location.search);
    if (q.get('server') || q.get('backend') || q.get('api')) {
      state.server = (q.get('server') || q.get('backend') || q.get('api')).replace(/\/+$/, '');
    }
    var queryKey = q.get('key') || q.get('apiKey') || q.get('api_key') || q.get('sdm_key');

    if (queryKey && !/[\u2022\u25cf\u22c5]/.test(queryKey)) {
      var cleanKey = queryKey.trim();
      var input = $('apikey');
      if (input) input.value = cleanKey;
      state.apiKey = cleanKey;

      // Update snippet in Step 1 to reflect real key
      var snippet = document.querySelector('pre code');
      if (snippet && snippet.textContent) {
        snippet.textContent = snippet.textContent.replace('sdm_live_your_key_here', cleanKey);
      }

      // Auto-click "Connect & start"
      setTimeout(function () {
        var btn = $('connect-btn');
        if (btn) btn.click();
        else connect();
      }, 100);
    } else {
      if ($('apikey')) $('apikey').value = '';
    }

    // Initialize 10 Examples Grid (4.1 to 4.10) and load default (4.1)
    renderExamplesGrid();
    loadExample(EXAMPLES[0]);
  });
})();
