/**
 * Shared ProxyRule schema helpers.
 *
 * This mirrors the Chrome extension's ProxyRule shape
 * (super-debug-extension/utils/proxy-storage.js) so cloud rules drop straight
 * into the extension's normalizeImportedRules → mergeEffectiveRules path and
 * the SDK interceptor without transformation.
 *
 * normalizeRule() is a pure, side-effect-free function that fills defaults and
 * strips unknown top-level fields. It intentionally does NOT assign ids or
 * timestamps (Mongo owns those) and does NOT sequence priority.
 */

/**
 * Normalize a raw rule-shaped object into a well-formed ProxyRule payload.
 * Returns null if the rule has no usable name (name is the merge identity).
 * @param {Object} raw
 * @returns {Object|null}
 */
function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const reqObj = raw.request && typeof raw.request === 'object' ? raw.request : {};
  const rw = reqObj.urlRewrite || reqObj.urlModify || null;
  const reqBody = reqObj.body && typeof reqObj.body === 'object' ? reqObj.body : {};
  const hasReqBodyContent = Boolean(
    (reqBody.value && String(reqBody.value).trim()) ||
    (reqBody.mergeValue && String(reqBody.mergeValue).trim())
  );
  const reqBodyEnabled = typeof reqBody.enabled === 'boolean'
    ? reqBody.enabled
    : hasReqBodyContent;

  const resObj = raw.response && typeof raw.response === 'object' ? raw.response : {};
  const resBody = resObj.body && typeof resObj.body === 'object' ? resObj.body : {};
  const hasResBodyContent = Boolean(
    (resBody.value && String(resBody.value).trim()) ||
    (resBody.mergeValue && String(resBody.mergeValue).trim()) ||
    (resBody.jsTransform && String(resBody.jsTransform).trim())
  );
  const resBodyEnabled = typeof resBody.enabled === 'boolean'
    ? resBody.enabled
    : hasResBodyContent;

  return {
    name,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    priority: typeof raw.priority === 'number' ? raw.priority : null,

    match: {
      urlPattern: typeof raw.match?.urlPattern === 'string' ? raw.match.urlPattern.trim() : '*',
      matchType: raw.match?.matchType || 'wildcard',
      methods: ['*'],
      resourceTypes: ['*'],
      ...(raw.match && typeof raw.match === 'object' ? raw.match : {}),
    },

    request: {
      redirectUrl: null,
      headers: [],
      delay: null,
      ...reqObj,
      urlRewrite: rw,
      urlModify: rw,
      body: {
        enabled: reqBodyEnabled,
        mode: reqBody.mode || (reqBody.action === 'merge' ? 'merge-json' : (reqBody.action || 'replace')),
        action: reqBody.action || (reqBody.mode === 'merge-json' ? 'merge' : (reqBody.mode || 'replace')),
        value: reqBody.value != null ? String(reqBody.value) : '',
        mergeValue: reqBody.mergeValue != null ? String(reqBody.mergeValue) : '',
      },
    },

    response: {
      headers: [],
      ...resObj,
      body: {
        enabled: resBodyEnabled,
        mode: resBody.mode || 'merge-json',
        value: resBody.value != null ? String(resBody.value) : '',
        mergeValue: resBody.mergeValue != null ? String(resBody.mergeValue) : '',
        jsTransform: resBody.jsTransform != null ? String(resBody.jsTransform) : '',
        contentType: resBody.contentType || 'application/json',
        statusCode: typeof resBody.statusCode === 'number' ? resBody.statusCode : 200,
      },
    },

    block: typeof raw.block === 'boolean' ? raw.block : false,

    injectScript: {
      enabled: false,
      code: '',
      ...(raw.injectScript && typeof raw.injectScript === 'object' ? raw.injectScript : {}),
    },
  };
}

/**
 * Normalize an array of raw rules, dropping any that lack a usable name.
 * @param {Array} rawRules
 * @returns {Array<Object>}
 */
function normalizeRules(rawRules) {
  if (!Array.isArray(rawRules)) return [];
  const out = [];
  for (const raw of rawRules) {
    const norm = normalizeRule(raw);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * Project a stored Rule document into the exact ProxyRule wire shape the
 * extension + SDK expect (id from Mongo _id, timestamps as epoch millis).
 * @param {Object} doc - a Mongoose Rule doc or plain object
 * @returns {Object}
 */
function toProxyRule(doc) {
  const r = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const rw = r.request?.urlRewrite || r.request?.urlModify || null;
  return {
    id: String(r._id || r.id),
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    match: r.match,
    request: {
      ...r.request,
      urlRewrite: rw,
      urlModify: rw,
    },
    response: r.response,
    block: r.block,
    injectScript: r.injectScript,
    apiKey: r.apiKey ? String(r.apiKey) : null,
    createdAt: r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
    updatedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now(),
  };
}

module.exports = { normalizeRule, normalizeRules, toProxyRule };
