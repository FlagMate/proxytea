/**
 * Server-Side MITM Interception Engine for ProxyTea Cloud.
 *
 * Evaluates and applies ProxyRules directly on the backend before & after
 * forwarding requests to upstream servers.
 *
 * Replicates the exact semantics of the SDK and Chrome Extension:
 * - URL matching (wildcard, exact, regex)
 * - Method matching
 * - Priority sorting (ascending)
 * - URL rewrite & redirect
 * - Request header modifications
 * - Request body modifications (deep-merge, replace, delete - guarded against GET/HEAD)
 * - Synthetic mocks (synthesizes response without hitting upstream)
 * - Request blocking
 * - Artificial delays (request and response latency)
 * - Response status overrides
 * - Response header modifications
 * - Response body modifications (replace, merge-json, js-transform)
 */

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function safeParse(str, fallback) {
  if (typeof str !== 'string') return str || fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Deep merge source into target.
 * - null deletes key
 * - plain objects merge recursively
 * - arrays and primitives overwrite
 */
function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val === null) {
      delete result[key];
    } else if (isPlainObject(val) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * URL matching logic matching SDK and Extension.
 */
function matchUrl(requestUrl, matchConfig) {
  const urlPattern = matchConfig?.urlPattern;
  const matchType = matchConfig?.matchType || 'wildcard';

  if (!urlPattern || urlPattern === '*') return true;

  switch (matchType) {
    case 'exact':
      return requestUrl === urlPattern;

    case 'wildcard': {
      const escaped = urlPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const regexStr = escaped.replace(/\*/g, '.*');
      const hasWildcard = urlPattern.indexOf('*') !== -1;
      const looksLikeFullUrl =
        urlPattern.indexOf('http://') === 0 || urlPattern.indexOf('https://') === 0;
      const regex =
        hasWildcard || looksLikeFullUrl
          ? new RegExp('^' + regexStr + '$')
          : new RegExp(regexStr);
      return regex.test(requestUrl);
    }

    case 'regex':
      try {
        return new RegExp(urlPattern).test(requestUrl);
      } catch {
        return false;
      }

    default:
      return false;
  }
}

/**
 * HTTP Method matching logic.
 */
function matchMethod(method, methods) {
  if (!methods || methods.length === 0 || methods[0] === '*') return true;
  const m = String(method || 'GET').toLowerCase();
  return methods.some((x) => String(x).toLowerCase() === m);
}

/**
 * Filter and sort rules that match the request URL and method.
 */
function getMatchingRules(rules, url, method) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule) => {
      if (!rule || rule.enabled === false) return false;
      if (!rule.match) return false;
      return matchUrl(url, rule.match) && matchMethod(method, rule.match.methods);
    })
    .sort((a, b) => {
      const pa = typeof a.priority === 'number' ? a.priority : 1e9;
      const pb = typeof b.priority === 'number' ? b.priority : 1e9;
      return pa - pb;
    });
}

function delay(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply server-side MITM transformations.
 */
async function processServerMitm({ url, method, headers = {}, body, rules = [] }) {
  let targetUrl = url;
  const targetMethod = String(method || 'GET').toUpperCase();
  const reqHeaders = { ...headers };
  let reqBody = body;

  const matched = getMatchingRules(rules, targetUrl, targetMethod);
  if (!matched.length) {
    return {
      matched: [],
      targetUrl,
      targetMethod,
      reqHeaders,
      reqBody,
      isBlocked: false,
      isMocked: false,
      mockResponse: null,
      preDelay: 0,
      postDelay: 0,
      transformResponse: (status, statusText, resHeaders, resData) => ({
        status,
        statusText,
        headers: resHeaders,
        data: resData,
      }),
    };
  }

  let isBlocked = false;
  let blockReason = 'Blocked by Server MITM Rule';
  let mockRule = null;
  let preDelay = 0;
  let postDelay = 0;

  for (const rule of matched) {
    if (rule.block) {
      isBlocked = true;
      blockReason = `Blocked by rule: "${rule.name}"`;
    }

    // URL rewrite / redirect (ignore self-referential /mitm endpoints to prevent loop)
    if (rule.request?.redirectUrl && !rule.request.redirectUrl.includes('/mitm')) {
      targetUrl = rule.request.redirectUrl;
    }
    const rw = rule.request?.urlRewrite || rule.request?.urlModify;
    if (rw && rw.find) {
      try {
        targetUrl = targetUrl.split(rw.find).join(rw.replace || '');
      } catch {}
    }

    // Request delay
    if (typeof rule.request?.delay === 'number' && rule.request.delay > 0) {
      preDelay = Math.max(preDelay, rule.request.delay);
    }

    // Response delay
    if (typeof rule.response?.delay === 'number' && rule.response.delay > 0) {
      postDelay = Math.max(postDelay, rule.response.delay);
    }

    // Request Headers modify
    const headerOps = Array.isArray(rule.request?.headers)
      ? rule.request.headers
      : rule.request?.headers?.modify;
    if (Array.isArray(headerOps)) {
      for (const op of headerOps) {
        if (!op || !op.name) continue;
        const key = op.name.toLowerCase();
        if (op.op === 'remove') {
          delete reqHeaders[key];
        } else {
          reqHeaders[key] = String(op.value || '');
        }
      }
    }

    // Request body modifications (only for non-GET/HEAD)
    if (targetMethod !== 'GET' && targetMethod !== 'HEAD' && rule.request?.body?.enabled) {
      const b = rule.request.body;
      const mode = b.mode || b.action || 'replace';
      try {
        if (mode === 'merge-json' || mode === 'merge') {
          const origObj = safeParse(reqBody, {});
          const mergeObj = safeParse(b.mergeValue || b.value, {});
          reqBody = JSON.stringify(deepMerge(origObj, mergeObj));
        } else if (mode === 'delete') {
          reqBody = '';
        } else {
          reqBody = b.value != null ? String(b.value) : reqBody;
        }
      } catch (e) {
        // Fail-safe: keep original body
      }
    }

    // Mock response check (mode replace/mock on response body without hitting network)
    const resB = rule.response?.body;
    if (resB && resB.enabled && (resB.mode === 'mock' || resB.mode === 'replace') && resB.value != null && resB.value !== '') {
      mockRule = rule;
    }
  }

  // Handle Blocked
  if (isBlocked) {
    return {
      matched,
      targetUrl,
      targetMethod,
      reqHeaders,
      reqBody,
      isBlocked: true,
      isMocked: false,
      mockResponse: {
        status: 403,
        statusText: 'Forbidden (Blocked by Rule)',
        headers: { 'content-type': 'application/json', 'x-proxytea-blocked': 'true' },
        data: { error: blockReason, success: false },
      },
      preDelay,
      postDelay,
      transformResponse: null,
    };
  }

  // Handle Synthetic Mock
  if (mockRule) {
    const mb = mockRule.response.body;
    let mockData = mb.value;
    try {
      mockData = JSON.parse(mb.value);
    } catch {}

    const mockHeaders = {
      'content-type': mb.contentType || 'application/json',
      'x-proxytea-mocked': 'true',
    };

    // Apply any response header operations from matched rules
    for (const rule of matched) {
      const resHeaderOps = Array.isArray(rule.response?.headers)
        ? rule.response.headers
        : rule.response?.headers?.modify;
      if (Array.isArray(resHeaderOps)) {
        for (const op of resHeaderOps) {
          if (!op || !op.name) continue;
          const key = op.name.toLowerCase();
          if (op.op === 'remove') {
            delete mockHeaders[key];
          } else {
            mockHeaders[key] = String(op.value || '');
          }
        }
      }
    }

    return {
      matched,
      targetUrl,
      targetMethod,
      reqHeaders,
      reqBody,
      isBlocked: false,
      isMocked: true,
      mockResponse: {
        status: typeof mb.statusCode === 'number' ? mb.statusCode : 200,
        statusText: 'OK (Mocked)',
        headers: mockHeaders,
        data: mockData,
      },
      preDelay,
      postDelay,
      transformResponse: null,
    };
  }

  // Response transformation function
  const transformResponse = (upstreamStatus, upstreamStatusText, upstreamHeaders, upstreamData) => {
    let finalStatus = upstreamStatus;
    let finalStatusText = upstreamStatusText;
    const finalHeaders = { ...upstreamHeaders };
    let finalData = upstreamData;

    for (const rule of matched) {
      // Status code override
      if (rule.response?.body?.enabled && typeof rule.response.body.statusCode === 'number') {
        finalStatus = rule.response.body.statusCode;
      }

      // Response headers modify
      const resHeaderOps = Array.isArray(rule.response?.headers)
        ? rule.response.headers
        : rule.response?.headers?.modify;
      if (Array.isArray(resHeaderOps)) {
        for (const op of resHeaderOps) {
          if (!op || !op.name) continue;
          const key = op.name.toLowerCase();
          if (op.op === 'remove') {
            delete finalHeaders[key];
          } else {
            finalHeaders[key] = String(op.value || '');
          }
        }
      }

      // Response body modify
      const resB = rule.response?.body;
      if (resB && resB.enabled) {
        const mode = resB.mode || 'merge-json';
        try {
          if (mode === 'replace' || mode === 'mock') {
            if (resB.value != null) {
              finalData = safeParse(resB.value, resB.value);
            }
          } else if (mode === 'merge-json') {
            const targetObj = typeof finalData === 'object' && finalData !== null
              ? finalData
              : safeParse(finalData, {});
            const deltaObj = safeParse(resB.mergeValue || resB.value, {});
            finalData = deepMerge(targetObj, deltaObj);
          } else if (mode === 'js-transform' && resB.jsTransform) {
            // Evaluates transform function
            // eslint-disable-next-line no-new-func
            const fn = new Function('response', resB.jsTransform);
            const parsed = typeof finalData === 'string' ? safeParse(finalData, finalData) : finalData;
            finalData = fn(parsed);
          }
        } catch (err) {
          // Fail-safe: keep existing finalData
        }
      }
    }

    return {
      status: finalStatus,
      statusText: finalStatusText,
      headers: finalHeaders,
      data: finalData,
    };
  };

  return {
    matched,
    targetUrl,
    targetMethod,
    reqHeaders,
    reqBody,
    isBlocked: false,
    isMocked: false,
    mockResponse: null,
    preDelay,
    postDelay,
    transformResponse,
  };
}

module.exports = {
  isPlainObject,
  safeParse,
  deepMerge,
  matchUrl,
  matchMethod,
  getMatchingRules,
  delay,
  processServerMitm,
};
