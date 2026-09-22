function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
/* SuperDebug / ProxyTea SDK v2.0.1 — Debug UMD build with Source Map. */
(function (root, factory) {
  // If SuperDebug namespace already exists, discard duplicate execution
  var isBrowser = typeof window !== 'undefined';
  var existing = isBrowser && window.SuperDebug || typeof root !== 'undefined' && root && root.SuperDebug;
  if (existing) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SuperDebug] window.SuperDebug namespace already exists — discarding duplicate script execution.');
    }
    if ((typeof module === "undefined" ? "undefined" : _typeof(module)) === 'object' && module.exports) {
      module.exports = existing;
    }
    return;
  }
  var exp = factory();
  if ((typeof module === "undefined" ? "undefined" : _typeof(module)) === 'object' && module.exports) {
    module.exports = exp;
  } else if (typeof define === 'function' && define.amd) {
    define([], function () {
      return exp;
    });
  }
  if (root) {
    root.SuperDebug = exp;
  }
  if (isBrowser) {
    window.SuperDebug = exp;
  }
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  if (typeof window !== 'undefined' && window.SuperDebug) {
    return window.SuperDebug;
  }
  var __SDK_DEFAULT__;

  // ==== src/logger.js ====
  /**
   * Tiny namespaced logger. Silent unless `debug: true` is passed to init().
   */
  var TAG = '[SuperDebugSDK]';
  var enabled = false;
  function setDebug(on) {
    enabled = Boolean(on);
  }
  var log = {
    info: function info() {
      if (!enabled) return;
      var args = [TAG].concat(Array.prototype.slice.call(arguments));
      // eslint-disable-next-line no-console
      console.log.apply(console, args);
    },
    warn: function warn() {
      var args = [TAG].concat(Array.prototype.slice.call(arguments));
      // eslint-disable-next-line no-console
      console.warn.apply(console, args);
    },
    error: function error() {
      var args = [TAG].concat(Array.prototype.slice.call(arguments));
      // eslint-disable-next-line no-console
      console.error.apply(console, args);
    }
  };

  // ==== src/merge.js ====
  /**
   * Deep JSON merge — mirrors the extension's deepMergePayload semantics:
   *   - `null` in source removes the key from target
   *   - plain-object values merge recursively
   *   - everything else (arrays, primitives) replaces
   */

  function isPlainObject(v) {
    return v && _typeof(v) === 'object' && !Array.isArray(v);
  }

  /**
   * @param {Object} target
   * @param {Object} source
   * @returns {Object} the mutated target
   */
  function deepMerge(target, source) {
    if (!isPlainObject(target) || !isPlainObject(source)) return source;
    Object.keys(source).forEach(function (key) {
      var val = source[key];
      if (val === null) {
        delete target[key];
      } else if (isPlainObject(val) && isPlainObject(target[key])) {
        deepMerge(target[key], val);
      } else {
        target[key] = val;
      }
    });
    return target;
  }

  /**
   * Safely parse JSON, returning a fallback on failure (fail-safe: never throw).
   * @param {string} str
   * @param {*} fallback
   */
  function safeParse(str, fallback) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return fallback;
    }
  }

  // ==== src/matching.js ====
  /**
   * URL + method matching — mirrors the Chrome extension's fetch-interceptor
   * semantics (super-debug-extension/utils/fetch-interceptor.js) so a rule
   * authored in the cloud behaves identically in the extension and the SDK.
   */

  /**
   * @param {string} requestUrl
   * @param {{ urlPattern?: string, matchType?: string }} matchConfig
   * @returns {boolean}
   */
  function matchUrl(requestUrl, matchConfig) {
    var urlPattern = matchConfig && matchConfig.urlPattern;
    var matchType = matchConfig && matchConfig.matchType || 'wildcard';
    if (!urlPattern || urlPattern === '*') return true;
    switch (matchType) {
      case 'exact':
        return requestUrl === urlPattern;
      case 'wildcard':
        {
          var escaped = urlPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
          var regexStr = escaped.replace(/\*/g, '.*');
          var hasWildcard = urlPattern.indexOf('*') !== -1;
          var looksLikeFullUrl = urlPattern.indexOf('http://') === 0 || urlPattern.indexOf('https://') === 0;
          var regex = hasWildcard || looksLikeFullUrl ? new RegExp('^' + regexStr + '$') : new RegExp(regexStr);
          return regex.test(requestUrl);
        }
      case 'regex':
        try {
          return new RegExp(urlPattern).test(requestUrl);
        } catch (e) {
          return false;
        }
      default:
        return false;
    }
  }

  /**
   * @param {string} method
   * @param {string[]} methods
   * @returns {boolean}
   */
  function matchMethod(method, methods) {
    if (!methods || methods.length === 0 || methods[0] === '*') return true;
    var m = String(method || 'GET');
    return methods.some(function (x) {
      return String(x).toLowerCase() === m.toLowerCase();
    });
  }

  /**
   * Return the enabled rules matching a request, sorted by priority ascending
   * (lower priority number applies first — matches the extension).
   * @param {Array} rules
   * @param {string} url
   * @param {string} method
   * @returns {Array}
   */
  function getMatchingRules(rules, url, method) {
    if (!Array.isArray(rules)) return [];
    return rules.filter(function (rule) {
      if (!rule || rule.enabled === false) return false;
      if (!rule.match) return false;
      return matchUrl(url, rule.match) && matchMethod(method, rule.match.methods);
    }).sort(function (a, b) {
      var pa = typeof a.priority === 'number' ? a.priority : 1e9;
      var pb = typeof b.priority === 'number' ? b.priority : 1e9;
      return pa - pb;
    });
  }

  // ==== src/rulesClient.js ====
  /**
   * Fetches cloud rules for an API key from the Super Debug backend's public
   * endpoint (GET /public/rules). Uses the ORIGINAL (unpatched) fetch captured at
   * init time so rule-fetching is never itself intercepted.
   */

  /**
   * @param {Function} originalFetch - the pristine window.fetch reference
   * @param {string} serverBaseUrl - e.g. http://localhost:3000
   * @param {string} apiKey
   * @param {boolean} includeDisabled
   * @returns {Promise<Array>} ProxyRule[] (empty on any failure — fail-safe)
   */
  function fetchRules(originalFetch, serverBaseUrl, apiKey, includeDisabled) {
    var base = String(serverBaseUrl || '').replace(/\/+$/, '');
    var url = base + '/public/rules' + (includeDisabled ? '?includeDisabled=1' : '');
    return originalFetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey
      },
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      var rules = json && json.data && Array.isArray(json.data.rules) ? json.data.rules : [];
      log.info('Fetched ' + rules.length + ' cloud rule(s)');
      return rules;
    }).catch(function (err) {
      log.warn('Rule fetch failed (keeping existing rules):', err && err.message);
      return null; // null signals "keep current rules" — fail-safe
    });
  }

  // ==== src/ui.js ====
  /**
   * Floating UI Widget for SuperDebug / ProxyTea SDK.
   * Mounted when `showUI: true` is passed to SuperDebug.init().
   */
  function initFloatingUI(state, controller) {
    var doc = state.window && state.window.document;
    if (!doc || !doc.body) return null;

    // Remove any existing instance
    var existing = doc.getElementById('superdebug-floating-widget');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    // Inject CSS once
    if (!doc.getElementById('superdebug-widget-style')) {
      var style = doc.createElement('style');
      style.id = 'superdebug-widget-style';
      style.textContent = "\n      @keyframes sdm-spin {\n        from { transform: rotate(0deg); }\n        to   { transform: rotate(360deg); }\n      }\n      #superdebug-floating-widget {\n        position: fixed;\n        bottom: 20px;\n        right: 20px;\n        z-index: 2147483647;\n        font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif;\n        font-size: 12px;\n        color: #f1f5f9;\n        user-select: none;\n      }\n      .sdm-widget-pill {\n        display: inline-flex;\n        align-items: center;\n        gap: 8px;\n        background: #18202c;\n        border: 1px solid #334358;\n        padding: 7px 14px;\n        border-radius: 9999px;\n        cursor: pointer;\n        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 16px rgba(255, 107, 0, 0.2);\n        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);\n      }\n      .sdm-widget-pill:hover {\n        transform: translateY(-2px);\n        border-color: #ff6b00;\n        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5), 0 0 20px rgba(255, 107, 0, 0.35);\n      }\n      .sdm-widget-dot {\n        width: 8px;\n        height: 8px;\n        border-radius: 50%;\n        background: #00ffaa;\n        box-shadow: 0 0 8px #00ffaa;\n      }\n      .sdm-widget-dot.disabled {\n        background: #64748b;\n        box-shadow: none;\n      }\n      .sdm-widget-brand {\n        font-weight: 750;\n        background: linear-gradient(90deg, #ff8c00, #ff007f);\n        -webkit-background-clip: text;\n        -webkit-text-fill-color: transparent;\n      }\n      .sdm-widget-count {\n        background: #232d3d;\n        color: #94a3b8;\n        padding: 1px 6px;\n        border-radius: 999px;\n        font-size: 11px;\n        font-weight: 700;\n      }\n      .sdm-widget-drawer {\n        position: absolute;\n        bottom: 46px;\n        right: 0;\n        width: 320px;\n        max-height: 440px;\n        background: #141b24;\n        border: 1px solid #35465c;\n        border-radius: 12px;\n        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);\n        display: none;\n        flex-direction: column;\n        overflow: hidden;\n      }\n      .sdm-widget-drawer.open {\n        display: flex;\n      }\n      .sdm-drawer-header {\n        padding: 10px 14px;\n        background: #1a232f;\n        border-bottom: 1px solid #2d3b4d;\n        display: flex;\n        align-items: center;\n        justify-content: space-between;\n      }\n      .sdm-drawer-title {\n        font-weight: 700;\n        font-size: 12.5px;\n      }\n      .sdm-drawer-actions {\n        display: flex;\n        align-items: center;\n        gap: 4px;\n      }\n      .sdm-drawer-reload {\n        background: transparent;\n        border: none;\n        color: #94a3b8;\n        font-size: 15px;\n        cursor: pointer;\n        padding: 2px 5px;\n        line-height: 1;\n        border-radius: 4px;\n        transition: color 0.15s, background 0.15s;\n      }\n      .sdm-drawer-reload:hover {\n        color: #00ffaa;\n        background: rgba(0, 255, 170, 0.1);\n      }\n      .sdm-drawer-reload.spinning {\n        animation: sdm-spin 0.8s linear infinite;\n        pointer-events: none;\n        color: #00ffaa;\n      }\n      .sdm-drawer-close {\n        background: transparent;\n        border: none;\n        color: #94a3b8;\n        font-size: 16px;\n        cursor: pointer;\n        padding: 0 4px;\n      }\n      .sdm-drawer-toggle-row {\n        padding: 10px 14px;\n        background: #18202b;\n        display: flex;\n        align-items: center;\n        justify-content: space-between;\n        border-bottom: 1px solid #283344;\n      }\n      .sdm-btn-toggle {\n        padding: 4px 10px;\n        border-radius: 5px;\n        font-size: 11px;\n        font-weight: 700;\n        cursor: pointer;\n        border: 1px solid transparent;\n      }\n      .sdm-btn-toggle.active {\n        background: rgba(0, 255, 170, 0.15);\n        color: #00ffaa;\n        border-color: rgba(0, 255, 170, 0.4);\n      }\n      .sdm-btn-toggle.inactive {\n        background: rgba(239, 68, 68, 0.15);\n        color: #f87171;\n        border-color: rgba(239, 68, 68, 0.4);\n      }\n      .sdm-rules-list {\n        padding: 8px 14px;\n        overflow-y: auto;\n        max-height: 280px;\n        display: flex;\n        flex-direction: column;\n        gap: 6px;\n      }\n      .sdm-rule-item {\n        background: #1c2634;\n        border: 1px solid #2c3a4c;\n        border-radius: 6px;\n        padding: 6px 10px;\n        display: flex;\n        align-items: center;\n        justify-content: space-between;\n        gap: 8px;\n      }\n      .sdm-rule-pattern {\n        font-family: ui-monospace, monospace;\n        font-size: 11px;\n        color: #cbd5e1;\n        overflow: hidden;\n        text-overflow: ellipsis;\n        white-space: nowrap;\n        max-width: 210px;\n      }\n      .sdm-rule-checkbox {\n        cursor: pointer;\n        accent-color: #ff6b00;\n      }\n    ";
      doc.head.appendChild(style);
    }
    var widget = doc.createElement('div');
    widget.id = 'superdebug-floating-widget';
    var isOpen = false;
    var isReloading = false;
    function render() {
      var rules = state.rules || [];
      var enabledRules = rules.filter(function (r) {
        return r && r.enabled !== false;
      });
      var isProxyActive = state.proxyEnabled !== false;
      widget.innerHTML = "\n      <div class=\"sdm-widget-drawer ".concat(isOpen ? 'open' : '', "\">\n        <div class=\"sdm-drawer-header\">\n          <span class=\"sdm-drawer-title\">&#x26A1; ProxyTea / SuperDebug</span>\n          <div class=\"sdm-drawer-actions\">\n            <button class=\"sdm-drawer-reload ").concat(isReloading ? 'spinning' : '', "\" id=\"sdm-reload-btn\" title=\"Reload all rules from cloud\">&#x21BB;</button>\n            <button class=\"sdm-drawer-close\" id=\"sdm-close-btn\">&#xD7;</button>\n          </div>\n        </div>\n        <div class=\"sdm-drawer-toggle-row\">\n          <span>Proxy Interception</span>\n          <button class=\"sdm-btn-toggle ").concat(isProxyActive ? 'active' : 'inactive', "\" id=\"sdm-proxy-toggle-btn\">\n            ").concat(isProxyActive ? 'ENABLED' : 'DISABLED', "\n          </button>\n        </div>\n        <div class=\"sdm-rules-list\">\n          ").concat(rules.length === 0 ? '<div style="color:#64748b;font-size:11px;padding:8px 0;">No active rules loaded.</div>' : '', "\n          ").concat(rules.map(function (rule, idx) {
        var pat = rule.match && rule.match.urlPattern || rule.urlPattern || rule.pattern || '*';
        var isRuleOn = rule.enabled !== false;
        var rId = rule.id || rule._id || String(idx);
        return "\n              <div class=\"sdm-rule-item\">\n                <span class=\"sdm-rule-pattern\" title=\"".concat(pat, "\">").concat(pat, "</span>\n                <input type=\"checkbox\" class=\"sdm-rule-checkbox\" data-rule-id=\"").concat(rId, "\" ").concat(isRuleOn ? 'checked' : '', " />\n              </div>\n            ");
      }).join(''), "\n        </div>\n      </div>\n      <div class=\"sdm-widget-pill\" id=\"sdm-pill-btn\" title=\"Click to view SuperDebug rules\">\n        <span class=\"sdm-widget-dot ").concat(isProxyActive ? '' : 'disabled', "\"></span>\n        <span class=\"sdm-widget-brand\">ProxyTea</span>\n        <span class=\"sdm-widget-count\">").concat(enabledRules.length, "/").concat(rules.length, "</span>\n      </div>\n    ");

      // Pill toggle
      var pillBtn = widget.querySelector('#sdm-pill-btn');
      if (pillBtn) {
        pillBtn.onclick = function () {
          isOpen = !isOpen;
          render();
        };
      }

      // Close drawer
      var closeBtn = widget.querySelector('#sdm-close-btn');
      if (closeBtn) {
        closeBtn.onclick = function () {
          isOpen = false;
          render();
        };
      }

      // Reload button — calls loadAllRules() on the controller
      var reloadBtn = widget.querySelector('#sdm-reload-btn');
      if (reloadBtn) {
        reloadBtn.onclick = function () {
          if (isReloading) return;
          isReloading = true;
          render();
          var p = typeof controller.loadAllRules === 'function' ? controller.loadAllRules() : Promise.resolve();
          p.then(function () {
            isReloading = false;
            render();
          }).catch(function () {
            isReloading = false;
            render();
          });
        };
      }

      // Proxy on/off toggle
      var proxyToggleBtn = widget.querySelector('#sdm-proxy-toggle-btn');
      if (proxyToggleBtn) {
        proxyToggleBtn.onclick = function () {
          if (state.proxyEnabled !== false) {
            controller.disableProxy();
          } else {
            controller.enableProxy();
          }
          render();
        };
      }

      // Per-rule enable/disable checkboxes
      var checkboxes = widget.querySelectorAll('.sdm-rule-checkbox');
      for (var i = 0; i < checkboxes.length; i++) {
        checkboxes[i].onchange = function (e) {
          var id = e.target.getAttribute('data-rule-id');
          controller.toggleRule(id);
          render();
        };
      }
    }
    doc.body.appendChild(widget);
    render();
    return {
      update: function update() {
        render();
      },
      show: function show() {
        widget.style.display = 'block';
      },
      hide: function hide() {
        widget.style.display = 'none';
      },
      destroy: function destroy() {
        if (widget && widget.parentNode) {
          widget.parentNode.removeChild(widget);
        }
      }
    };
  }

  // ==== src/interceptor.js ====
  /**
   * The interceptor engine. Monkey-patches fetch, XMLHttpRequest, and
   * navigator.sendBeacon to apply cloud rules. Every transform is wrapped so a
   * failure falls back to the ORIGINAL behaviour — the SDK must never break the
   * host app (the extension's #1 guarantee).
   *
   * Supported rule actions (subset that makes sense client-side, matching the
   * extension's fetch-interceptor):
   *   - block                     → reject/abort the request
   *   - request.redirectUrl       → send to a different URL
   *   - request.urlRewrite        → find/replace in the URL
   *   - request.body (replace|merge-json)
   *   - request.delay             → artificial latency before send
   *   - response.body (replace|merge-json|js-transform)
   *   - response.statusCode       → override status
   */

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /** Apply a find/replace URL rewrite if configured. */
  function applyUrlRewrite(url, rule) {
    var req = rule.request || {};
    if (req.redirectUrl) return req.redirectUrl;
    var rw = req.urlRewrite || req.urlModify;
    if (rw && rw.find) {
      try {
        return url.split(rw.find).join(rw.replace || '');
      } catch (e) {
        return url;
      }
    }
  }

  /** Apply request header modifications configured in the rule, supporting $ORIGINAL_URL substitution. */
  function applyRequestHeaders(headersInput, rule, originalUrl) {
    var headerOps = Array.isArray(rule.request && rule.request.headers) ? rule.request.headers : rule.request && rule.request.headers && rule.request.headers.modify;
    if (!Array.isArray(headerOps) || !headerOps.length) return headersInput;
    if (typeof Headers !== 'undefined' && headersInput instanceof Headers) {
      headerOps.forEach(function (op) {
        if (!op || !op.name) return;
        if (op.op === 'remove') {
          headersInput.delete(op.name);
        } else {
          var val = String(op.value != null ? op.value : '');
          if (val === '$ORIGINAL_URL' || val === '$URL' || val === '{{url}}') {
            val = originalUrl;
          }
          headersInput.set(op.name, val);
        }
      });
      return headersInput;
    }
    var out = {};
    if (headersInput && _typeof(headersInput) === 'object') {
      if (Array.isArray(headersInput)) {
        headersInput.forEach(function (pair) {
          if (pair && pair[0]) out[pair[0]] = pair[1];
        });
      } else {
        for (var k in headersInput) {
          if (Object.prototype.hasOwnProperty.call(headersInput, k)) {
            out[k] = headersInput[k];
          }
        }
      }
    }
    headerOps.forEach(function (op) {
      if (!op || !op.name) return;
      var nameLower = op.name.toLowerCase();
      if (op.op === 'remove') {
        for (var existingKey in out) {
          if (existingKey.toLowerCase() === nameLower) {
            delete out[existingKey];
          }
        }
      } else {
        var val = String(op.value != null ? op.value : '');
        if (val === '$ORIGINAL_URL' || val === '$URL' || val === '{{url}}') {
          val = originalUrl;
        }
        out[op.name] = val;
      }
    });
    return out;
  }

  /** Compute the request body to send, given the original body string. */
  function applyRequestBody(originalBodyStr, rule) {
    var body = rule.request && rule.request.body;
    if (!body || !body.enabled) return originalBodyStr;
    var mode = body.mode || body.action || 'replace';
    try {
      if (mode === 'merge-json' || mode === 'merge') {
        var target = safeParse(originalBodyStr, {}) || {};
        var delta = safeParse(body.mergeValue || body.value, {});
        return JSON.stringify(deepMerge(target, delta));
      }
      if (mode === 'delete') {
        return '';
      }
      // replace
      var val = body.value != null && body.value !== '' ? body.value : body.mergeValue;
      return val != null ? String(val) : originalBodyStr;
    } catch (e) {
      log.warn('request body transform failed, using original:', e && e.message);
      return originalBodyStr;
    }
  }

  /**
   * Transform a response body string per the rule. Returns the (possibly new)
   * body string. Fail-safe: any error returns the original.
   */
  function applyResponseBody(originalBodyStr, rule) {
    var body = rule.response && rule.response.body;
    if (!body || !body.enabled) return originalBodyStr;
    try {
      // 'mock' and 'replace' both substitute the response body wholesale.
      if (body.mode === 'replace' || body.mode === 'mock') {
        return body.value != null ? String(body.value) : originalBodyStr;
      }
      if (body.mode === 'merge-json') {
        var target = safeParse(originalBodyStr, {}) || {};
        var delta = safeParse(body.mergeValue || body.value, {});
        return JSON.stringify(deepMerge(target, delta));
      }
      if (body.mode === 'js-transform' && body.jsTransform) {
        // Mirrors the extension: transform code runs with app privileges and is
        // trusted (it comes from the workspace owner via an authenticated API).
        // eslint-disable-next-line no-new-func
        var fn = new Function('response', body.jsTransform);
        var parsed = safeParse(originalBodyStr, originalBodyStr);
        var result = fn(parsed);
        return typeof result === 'string' ? result : JSON.stringify(result);
      }
    } catch (e) {
      log.warn('response body transform failed, using original:', e && e.message);
    }
    return originalBodyStr;
  }

  /**
   * Build the interceptor with a shared, mutable rules ref and the pristine
   * originals. `state.rules` is read live on every request so updates take
   * effect without re-patching.
   */
  function installInterceptors(state) {
    var win = state.window;
    var originals = state.originals;

    // ─── fetch ────────────────────────────────────────────────────────────────
    if (_typeof(win) === 'object' && win) {
      win.__superDebugOriginalFetch = originals.fetch;
    }
    if (typeof win.fetch === 'function') {
      win.fetch = function patchedFetch(input, init) {
        if (state.proxyEnabled === false) {
          return originals.fetch.call(win, input, init);
        }
        var url = typeof input === 'string' ? input : input && input.url;
        var method = init && init.method || input && input.method || 'GET';

        // Never intercept internal ProxyTea platform / proxy / auth / health endpoints
        if (typeof url === 'string' && (url.indexOf('/proxy') !== -1 || url.indexOf('/public/') !== -1 || url.indexOf('/health') !== -1 || url.indexOf('/auth/') !== -1)) {
          return originals.fetch.call(win, input, init);
        }
        var matched;
        try {
          matched = getMatchingRules(state.rules, url, method);
        } catch (e) {
          matched = [];
        }
        if (!matched.length) return originals.fetch.call(win, input, init);
        return runFetch(url, method, input, init, matched);
      };
    }
    function runFetch(url, method, input, init, matched) {
      var opts = Object.assign({}, init);
      var finalUrl = url;
      var blocked = false;
      var maxDelay = 0;
      matched.forEach(function (rule) {
        if (rule.block) blocked = true;
        finalUrl = applyUrlRewrite(finalUrl, rule);
        opts.headers = applyRequestHeaders(opts.headers, rule, url);
        if (rule.request && typeof rule.request.delay === 'number') {
          maxDelay = Math.max(maxDelay, rule.request.delay);
        }
        // request body (only for non-GET/HEAD methods as browser fetch forbids bodies on GET/HEAD)
        if (rule.request && rule.request.body && rule.request.body.enabled) {
          var reqMethod = String(init && init.method || _typeof(input) === 'object' && input.method || opts.method || 'GET').toUpperCase();
          if (reqMethod !== 'GET' && reqMethod !== 'HEAD') {
            var origBody = opts.body != null ? String(opts.body) : init && init.body || '';
            opts.body = applyRequestBody(origBody, rule);
          }
        }
      });

      // Auto-inject x-target-url if rewritten to /mitm and header not explicitly set
      if (typeof finalUrl === 'string' && finalUrl.indexOf('/mitm') !== -1) {
        if (typeof Headers !== 'undefined' && opts.headers instanceof Headers) {
          if (!opts.headers.has('x-target-url')) {
            opts.headers.set('x-target-url', url);
          }
        } else {
          opts.headers = opts.headers || {};
          var hasTargetHeader = false;
          for (var hk in opts.headers) {
            if (hk.toLowerCase() === 'x-target-url') {
              hasTargetHeader = true;
              break;
            }
          }
          if (!hasTargetHeader) {
            opts.headers['x-target-url'] = url;
          }
        }
      }
      if (blocked) {
        log.info('Blocked (fetch):', finalUrl);
        return Promise.reject(new TypeError('Blocked by Super Debug SDK rule'));
      }

      // Full-body mock: synthesize the response WITHOUT hitting the network, so
      // mocking works even for unbuilt/unreachable endpoints. Only applies when a
      // matched rule fully replaces the body (mode 'mock' or 'replace').
      var mockRule = null;
      matched.forEach(function (rule) {
        var b = rule.response && rule.response.body;
        if (b && b.enabled && (b.mode === 'mock' || b.mode === 'replace') && b.value != null) {
          mockRule = rule;
        }
      });
      if (mockRule) {
        var mb = mockRule.response.body;
        var mockStart = maxDelay > 0 ? delay(maxDelay) : Promise.resolve();
        return mockStart.then(function () {
          log.info('Mocked (fetch):', finalUrl);
          return new Response(String(mb.value), {
            status: typeof mb.statusCode === 'number' ? mb.statusCode : 200,
            statusText: 'OK',
            headers: {
              'Content-Type': mb.contentType || 'application/json'
            }
          });
        });
      }
      var start = maxDelay > 0 ? delay(maxDelay) : Promise.resolve();
      return start.then(function () {
        var target = finalUrl !== url && typeof input !== 'string' ? finalUrl // redirected: use string URL
        : finalUrl !== url ? finalUrl : input;
        return originals.fetch.call(win, target, opts);
      }).then(function (response) {
        return transformFetchResponse(response, matched);
      });
    }
    function transformFetchResponse(response, matched) {
      var needsBody = matched.some(function (r) {
        return r.response && r.response.body && r.response.body.enabled;
      });
      var statusOverride = null;
      matched.forEach(function (r) {
        if (r.response && r.response.body && r.response.body.enabled && typeof r.response.body.statusCode === 'number') {
          statusOverride = r.response.body.statusCode;
        }
      });
      if (!needsBody && statusOverride === null) return response;
      return response.clone().text().then(function (text) {
        var out = text;
        matched.forEach(function (rule) {
          out = applyResponseBody(out, rule);
        });
        var headers = new Headers(response.headers);
        var init = {
          status: statusOverride !== null ? statusOverride : response.status,
          statusText: response.statusText,
          headers: headers
        };
        return new Response(out, init);
      }).catch(function () {
        return response; // fail-safe
      });
    }

    // ─── XMLHttpRequest ─────────────────────────────────────────────────────────
    if (typeof win.XMLHttpRequest === 'function') {
      var OrigXHR = originals.XMLHttpRequest;
      var open = OrigXHR.prototype.open;
      var send = OrigXHR.prototype.send;
      var setRequestHeader = OrigXHR.prototype.setRequestHeader;
      OrigXHR.prototype.open = function (method, url) {
        if (state.proxyEnabled === false) {
          this.__sdm = null;
          return open.apply(this, arguments);
        }
        this.__sdm = {
          method: method,
          url: url,
          matched: []
        };
        try {
          this.__sdm.matched = getMatchingRules(state.rules, url, method);
        } catch (e) {
          this.__sdm.matched = [];
        }
        var finalUrl = url;
        this.__sdm.matched.forEach(function (rule) {
          finalUrl = applyUrlRewrite(finalUrl, rule);
        });
        this.__sdm.finalUrl = finalUrl;
        var args = Array.prototype.slice.call(arguments);
        args[1] = finalUrl;
        return open.apply(this, args);
      };
      OrigXHR.prototype.send = function (body) {
        if (state.proxyEnabled === false) {
          return send.call(this, body);
        }
        var sdm = this.__sdm;
        if (!sdm || !sdm.matched.length) return send.call(this, body);
        if (sdm.matched.some(function (r) {
          return r.block;
        })) {
          log.info('Blocked (xhr):', sdm.finalUrl);
          // Emulate a network error without hitting the server.
          var selfBlocked = this;
          setTimeout(function () {
            if (typeof selfBlocked.onerror === 'function') selfBlocked.onerror(new Event('error'));
            selfBlocked.dispatchEvent(new Event('error'));
          }, 0);
          return;
        }

        // Request header modifications on XHR
        var self = this;
        sdm.matched.forEach(function (rule) {
          var headerOps = Array.isArray(rule.request && rule.request.headers) ? rule.request.headers : rule.request && rule.request.headers && rule.request.headers.modify;
          if (Array.isArray(headerOps)) {
            headerOps.forEach(function (op) {
              if (!op || !op.name || op.op === 'remove') return;
              var val = String(op.value != null ? op.value : '');
              if (val === '$ORIGINAL_URL' || val === '$URL' || val === '{{url}}') {
                val = sdm.url;
              }
              try {
                setRequestHeader.call(self, op.name, val);
              } catch (e) {}
            });
          }
        });

        // Auto-inject x-target-url if rewritten to /mitm
        if (typeof sdm.finalUrl === 'string' && sdm.finalUrl.indexOf('/mitm') !== -1) {
          try {
            setRequestHeader.call(self, 'x-target-url', sdm.url);
          } catch (e) {}
        }

        // request body transform (only for non-GET/HEAD methods)
        var outBody = body;
        var xhrMethod = String(sdm.method || 'GET').toUpperCase();
        if (xhrMethod !== 'GET' && xhrMethod !== 'HEAD') {
          sdm.matched.forEach(function (rule) {
            if (rule.request && rule.request.body && rule.request.body.enabled) {
              outBody = applyRequestBody(body != null ? String(body) : '', rule);
            }
          });
        }

        // response body transform via property interception
        installXhrResponseTransform(this, sdm.matched);
        var maxDelay = 0;
        sdm.matched.forEach(function (rule) {
          if (rule.request && typeof rule.request.delay === 'number') {
            maxDelay = Math.max(maxDelay, rule.request.delay);
          }
        });
        var self2 = this;
        if (maxDelay > 0) {
          setTimeout(function () {
            send.call(self2, outBody);
          }, maxDelay);
        } else {
          send.call(this, outBody);
        }
      };
    }
    function installXhrResponseTransform(xhr, matched) {
      var wantsBody = matched.some(function (r) {
        return r.response && r.response.body && r.response.body.enabled;
      });
      if (!wantsBody) return;
      var realGetResponse = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(xhr), 'responseText');
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState === 4) {
          try {
            var original = realGetResponse && realGetResponse.get ? realGetResponse.get.call(xhr) : xhr.responseText;
            var out = original;
            matched.forEach(function (rule) {
              out = applyResponseBody(out, rule);
            });
            Object.defineProperty(xhr, 'responseText', {
              value: out,
              configurable: true
            });
            Object.defineProperty(xhr, 'response', {
              value: out,
              configurable: true
            });
          } catch (e) {
            log.warn('xhr response transform failed:', e && e.message);
          }
        }
      });
    }

    // ─── navigator.sendBeacon ────────────────────────────────────────────────────
    if (win.navigator && typeof win.navigator.sendBeacon === 'function') {
      win.navigator.sendBeacon = function patchedBeacon(url, data) {
        if (state.proxyEnabled === false) {
          return originals.sendBeacon.call(win.navigator, url, data);
        }
        var matched;
        try {
          matched = getMatchingRules(state.rules, url, 'POST');
        } catch (e) {
          matched = [];
        }
        if (!matched.length) return originals.sendBeacon.call(win.navigator, url, data);
        if (matched.some(function (r) {
          return r.block;
        })) {
          log.info('Blocked (beacon):', url);
          return true; // pretend it queued; nothing sent
        }
        var finalUrl = url;
        var outData = data;
        matched.forEach(function (rule) {
          finalUrl = applyUrlRewrite(finalUrl, rule);
          if (rule.request && rule.request.body && rule.request.body.enabled && typeof data === 'string') {
            outData = applyRequestBody(data, rule);
          }
        });
        return originals.sendBeacon.call(win.navigator, finalUrl, outData);
      };
    }
    log.info('Interceptors installed');
  }

  // ==== src/index.js ====
  /**
   * Super Debug / ProxyTea Cloud SDK — public API.
   *
   * Usage (web / TV app):
   *   import SuperDebug from 'super-debug-sdk';
   *   window.superDebugObj = SuperDebug.init({
   *     apiKey: 'sdm_live_qa_team_key',
   *     serverUrl: 'http://localhost:3000', // optional (pre-baked default)
   *     enableProxy: true,                  // optional (default: true)
   *     showUI: true,                       // optional (default: false)
   *     refreshInterval: 300000,            // optional ms (0 disables polling) (default: 300000ms = 300s)
   *   });
   *
   * Exposed Instance & Namespace Methods:
   *   window.superDebugObj.getAllRules()
   *   window.superDebugObj.disableProxy()
   *   window.superDebugObj.enableProxy()
   *   window.superDebugObj.isProxyEnabled()
   *   window.superDebugObj.toggleRule(ruleId)
   *   window.superDebugObj.enableRule(ruleId)
   *   window.superDebugObj.disableRule(ruleId)
   *   window.superDebugObj.getRule(ruleId)
   *   window.superDebugObj.addRule(rule)
   *   window.superDebugObj.removeRule(ruleId)
   *   window.superDebugObj.showUI()
   *   window.superDebugObj.hideUI()
   *   window.superDebugObj.loadAllRules()
   *   window.superDebugObj.destroy()
   */

  // Build-time baked server URL — replaced by build script from sdk/.env SDK_SERVER_URL.
  // NEVER falls back to window.location.origin (which would call the wrong host).
  var __BAKED_SERVER_URL__ = "https://proxytea.onrender.com";
  var __BAKED_SDK_VERSION__ = "2.0.1";
  var SDK_VERSION = typeof __BAKED_SDK_VERSION__ !== 'undefined' && __BAKED_SDK_VERSION__.indexOf('__') !== 0 ? __BAKED_SDK_VERSION__ : '2.0.1';
  function resolveDefaultServerUrl() {
    // 1. Explicit runtime global override (set before loading the SDK)
    if (typeof window !== 'undefined' && window.__SUPERDEBUG_SERVER_URL__) {
      return window.__SUPERDEBUG_SERVER_URL__;
    }
    // 2. Runtime localStorage override (set programmatically)
    try {
      var stored = typeof window !== 'undefined' && localStorage.getItem('sdm_server_url');
      if (stored) return stored;
    } catch (e) {}
    // 3. Build-time baked URL from sdk/.env SDK_SERVER_URL (always set to the real backend)
    if (__BAKED_SERVER_URL__ && __BAKED_SERVER_URL__.indexOf('__') !== 0) {
      return __BAKED_SERVER_URL__;
    }
    // 4. Dynamic origin fallback (never hardcode localhost)
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      return window.location.origin;
    }
    return '';
  }
  var DEFAULT_SERVER_URL = resolveDefaultServerUrl();
  var state = {
    window: typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : {},
    originals: null,
    rules: [],
    installed: false,
    timer: null,
    config: null,
    proxyEnabled: true,
    ui: null
  };
  function captureOriginals(win) {
    return {
      fetch: typeof win.fetch === 'function' ? win.fetch.bind(win) : null,
      XMLHttpRequest: win.XMLHttpRequest,
      sendBeacon: win.navigator && typeof win.navigator.sendBeacon === 'function' ? win.navigator.sendBeacon : null
    };
  }
  function findRule(ruleId) {
    if (!ruleId && ruleId !== 0) return null;
    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      if (r && (r.id === ruleId || r._id === ruleId || String(r.id) === String(ruleId) || String(i) === String(ruleId))) {
        return r;
      }
    }
    return null;
  }

  // Controller implementation containing all required API methods
  var controller = {
    /** Return all in-memory rules. */
    getAllRules: function getAllRules() {
      return state.rules.slice();
    },
    /** Alias for getAllRules. */
    getRules: function getRules() {
      return state.rules.slice();
    },
    /** Get a single rule by ID or index. */
    getRule: function getRule(ruleId) {
      return findRule(ruleId);
    },
    /** Disable all network interception (pass-through directly to original network). */
    disableProxy: function disableProxy() {
      state.proxyEnabled = false;
      if (state.ui && typeof state.ui.update === 'function') state.ui.update();
      log.info('Proxy interception disabled');
      return false;
    },
    /** Enable network interception. */
    enableProxy: function enableProxy() {
      state.proxyEnabled = true;
      if (state.ui && typeof state.ui.update === 'function') state.ui.update();
      log.info('Proxy interception enabled');
      return true;
    },
    /** Returns whether proxy interception is currently active. */
    isProxyEnabled: function isProxyEnabled() {
      return state.proxyEnabled !== false;
    },
    /** Toggle enabled flag on a specific rule by ID. */
    toggleRule: function toggleRule(ruleId) {
      var r = findRule(ruleId);
      if (!r) {
        log.warn('toggleRule: rule not found for ID', ruleId);
        return null;
      }
      r.enabled = r.enabled === false ? true : false;
      if (state.ui && typeof state.ui.update === 'function') state.ui.update();
      log.info('Rule ' + ruleId + ' toggled to:', r.enabled);
      return r;
    },
    /** Enable a specific rule by ID. */
    enableRule: function enableRule(ruleId) {
      var r = findRule(ruleId);
      if (!r) {
        log.warn('enableRule: rule not found for ID', ruleId);
        return null;
      }
      r.enabled = true;
      if (state.ui && typeof state.ui.update === 'function') state.ui.update();
      log.info('Rule ' + ruleId + ' enabled');
      return r;
    },
    /** Disable a specific rule by ID. */
    disableRule: function disableRule(ruleId) {
      var r = findRule(ruleId);
      if (!r) {
        log.warn('disableRule: rule not found for ID', ruleId);
        return null;
      }
      r.enabled = false;
      if (state.ui && typeof state.ui.update === 'function') state.ui.update();
      log.info('Rule ' + ruleId + ' disabled');
      return r;
    },
    /** Add a new rule dynamically to in-memory rules list. */
    addRule: function addRule(rule) {
      if (!rule) return null;
      if (!rule.id && !rule._id) rule.id = 'rule_client_' + Date.now();
      if (typeof rule.enabled === 'undefined') rule.enabled = true;
      state.rules.push(rule);
      if (state.ui && typeof state.ui.update === 'function') state.ui.update();
      return rule;
    },
    /** Remove a rule by ID. */
    removeRule: function removeRule(ruleId) {
      var idx = -1;
      for (var i = 0; i < state.rules.length; i++) {
        var r = state.rules[i];
        if (r && (r.id === ruleId || r._id === ruleId || String(r.id) === String(ruleId) || String(i) === String(ruleId))) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return false;
      state.rules.splice(idx, 1);
      if (state.ui && typeof state.ui.update === 'function') state.ui.update();
      return true;
    },
    /** Manually set/override the active rule set (e.g. for tests or offline). */
    setRules: function setRules(rules) {
      state.rules = Array.isArray(rules) ? rules : [];
      if (state.ui && typeof state.ui.update === 'function') state.ui.update();
      return state.rules.slice();
    },
    /** Re-fetch rules from the cloud now. */
    refresh: function refresh() {
      return SuperDebug.refresh();
    },
    /**
     * Force a full re-fetch of all rules from the cloud server.
     * Triggers interceptor re-install and UI update.
     * Callable as: window.superDebugObj.loadAllRules()
     * @returns {Promise<{rules: Array}>}
     */
    loadAllRules: function loadAllRules() {
      log.info('loadAllRules() called — forcing full cloud rule re-fetch');
      return SuperDebug.refresh().then(function (result) {
        if (state.ui && typeof state.ui.update === 'function') state.ui.update();
        return result;
      });
    },
    /** Show floating UI if installed. */
    showUI: function showUI() {
      if (!state.ui) {
        state.ui = initFloatingUI(state, controller);
      }
      if (state.ui && typeof state.ui.show === 'function') {
        state.ui.show();
      }
    },
    /** Hide floating UI. */
    hideUI: function hideUI() {
      if (state.ui && typeof state.ui.hide === 'function') {
        state.ui.hide();
      }
    },
    /** Stop polling, teardown UI, and restore original fetch/XHR/sendBeacon. */
    destroy: function destroy() {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      if (state.ui && typeof state.ui.destroy === 'function') {
        state.ui.destroy();
        state.ui = null;
      }
      if (state.installed && state.originals) {
        var win = state.window;
        if (state.originals.fetch) win.fetch = state.originals.fetch;
        if (state.originals.XMLHttpRequest) win.XMLHttpRequest = state.originals.XMLHttpRequest;
        if (state.originals.sendBeacon && win.navigator) {
          win.navigator.sendBeacon = state.originals.sendBeacon;
        }
      }
      state.installed = false;
      state.rules = [];
      log.info('SDK destroyed, originals restored');
    },
    /** Returns active or pre-baked backend server URL. */
    getServerUrl: function getServerUrl() {
      return state.config && state.config.serverBaseUrl || DEFAULT_SERVER_URL;
    },
    /** Returns unpatched pristine window.fetch reference. */
    getOriginalFetch: function getOriginalFetch() {
      return state.originals && state.originals.fetch || (typeof window !== 'undefined' ? window.fetch : null);
    },
    version: SDK_VERSION
  };
  var SuperDebug = {
    /**
     * Initializes the SuperDebug / ProxyTea SDK.
     *
     * @param {{
     *   apiKey?: string,
     *   serverUrl?: string,
     *   serverBaseUrl?: string,
     *   enableProxy?: boolean,
     *   showUI?: boolean,
     *   refreshInterval?: number,
     *   includeDisabled?: boolean,
     *   debug?: boolean,
     *   rules?: Array
     * }} options
     * @returns {controller & PromiseLike} Returns controller object synchronously, which also supports .then()
     */
    init: function init(options) {
      options = options || {};
      setDebug(options.debug);

      // Resolve the global object at init time
      if (options.window) {
        state.window = options.window;
      } else if (typeof window !== 'undefined') {
        state.window = window;
      } else if (typeof self !== 'undefined') {
        state.window = self;
      }
      if (!options.apiKey && !(options.rules && options.rules.length)) {
        log.warn('init() called without an apiKey — using local or pre-seeded rules.');
      }

      // Default server URL pre-baked — overriding is optional
      var serverBaseUrl = options.serverUrl || options.serverBaseUrl || DEFAULT_SERVER_URL;

      // enableProxy default is true
      state.proxyEnabled = typeof options.enableProxy === 'boolean' ? options.enableProxy : true;
      state.config = {
        apiKey: options.apiKey || null,
        serverBaseUrl: serverBaseUrl,
        refreshInterval: typeof options.refreshInterval === 'number' ? options.refreshInterval : 300000,
        includeDisabled: Boolean(options.includeDisabled),
        showUI: Boolean(options.showUI)
      };

      // Seed rules synchronously if provided
      if (Array.isArray(options.rules)) state.rules = options.rules;

      // Capture pristine originals ONCE, then install patches
      if (!state.installed) {
        state.originals = captureOriginals(state.window);
        installInterceptors(state);
        state.installed = true;
      }

      // Initialize floating UI if requested
      if (state.config.showUI) {
        state.ui = initFloatingUI(state, controller);
      }

      // Initial fetch + optional polling
      var refresh = SuperDebug.refresh.bind(SuperDebug);
      var first = state.config.apiKey ? refresh() : Promise.resolve({
        rules: state.rules
      });
      if (state.config.apiKey && state.config.refreshInterval > 0) {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(refresh, state.config.refreshInterval);
      }

      // Expose instance on window.superDebugObj automatically in browser
      if (typeof window !== 'undefined') {
        window.superDebugObj = controller;
      }

      // Create a Thenable controller: callers can immediately use synchronous methods
      // (e.g. window.superDebugObj = SuperDebug.init(...); window.superDebugObj.getAllRules())
      // OR await it (e.g. const res = await SuperDebug.init(...))
      var instance = Object.create(controller);
      instance.ready = first;
      instance.then = function (onFulfilled, onRejected) {
        return first.then(function (res) {
          return onFulfilled ? onFulfilled(res) : res;
        }, onRejected);
      };
      instance.catch = function (onRejected) {
        return first.catch(onRejected);
      };
      return instance;
    },
    /** Re-fetch rules from the cloud now. */
    refresh: function refresh() {
      if (!state.config || !state.config.apiKey) {
        return Promise.resolve({
          rules: state.rules
        });
      }
      var orig = state.originals && state.originals.fetch || state.window.fetch.bind(state.window);
      return fetchRules(orig, state.config.serverBaseUrl, state.config.apiKey, state.config.includeDisabled).then(function (rules) {
        if (rules !== null) state.rules = rules;
        if (state.ui && typeof state.ui.update === 'function') state.ui.update();
        return {
          rules: state.rules
        };
      });
    },
    version: SDK_VERSION
  };

  // Mirror all controller methods directly onto SuperDebug namespace
  Object.keys(controller).forEach(function (key) {
    if (typeof controller[key] === 'function' && !SuperDebug[key]) {
      SuperDebug[key] = controller[key];
    }
  });
  SuperDebug.DEFAULT_SERVER_URL = DEFAULT_SERVER_URL;
  SuperDebug.version = SDK_VERSION;
  if (typeof window !== 'undefined') {
    window.SuperDebug = SuperDebug;
  }
  __SDK_DEFAULT__ = SuperDebug;
  return __SDK_DEFAULT__;
});
//# sourceMappingURL=superdebug-debug.js.map
