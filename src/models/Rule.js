const { mongoose } = require('../config/db');

/**
 * A Rule belongs to a Profile and mirrors the Chrome extension's ProxyRule shape
 * (see backend/src/lib/ruleSchema.js and super-debug-extension/utils/proxy-storage.js).
 *
 * Nested objects use `Mixed`/loose subschemas so the rule shape can evolve with
 * the extension without a migration. Normalization/validation happens in the
 * service layer via ruleSchema.normalizeRule().
 */
const headerOpSchema = new mongoose.Schema(
  {
    op: { type: String, default: 'set' }, // set | remove
    name: { type: String, default: '' },
    value: { type: String, default: '' },
  },
  { _id: false }
);

const matchSchema = new mongoose.Schema(
  {
    urlPattern: { type: String, default: '*', trim: true },
    matchType: { type: String, default: 'wildcard' }, // wildcard | regex
    methods: { type: [String], default: ['*'] },
    resourceTypes: { type: [String], default: ['*'] },
  },
  { _id: false }
);

const requestSchema = new mongoose.Schema(
  {
    redirectUrl: { type: String, default: null },
    // Find & replace URL rewrite (optional) — mirrors extension request modes.
    urlRewrite: { type: mongoose.Schema.Types.Mixed, default: null },
    headers: { type: [headerOpSchema], default: [] },
    body: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, default: 'replace' }, // replace | merge-json
      value: { type: String, default: '' },
      mergeValue: { type: String, default: '' },
    },
    delay: { type: Number, default: null },
  },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  {
    headers: { type: [headerOpSchema], default: [] },
    body: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, default: 'merge-json' }, // replace | merge-json | js-transform
      value: { type: String, default: '' },
      mergeValue: { type: String, default: '' },
      jsTransform: { type: String, default: '' },
      contentType: { type: String, default: 'application/json' },
      statusCode: { type: Number, default: 200 },
    },
  },
  { _id: false }
);

const ruleSchema = new mongoose.Schema(
  {
    profile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Profile',
      required: false,
      index: true,
    },
    apiKey: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApiKey',
      index: true,
      default: null,
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    priority: { type: Number, default: null },
    match: { type: matchSchema, default: () => ({}) },
    request: { type: requestSchema, default: () => ({}) },
    response: { type: responseSchema, default: () => ({}) },
    block: { type: Boolean, default: false },
    injectScript: {
      enabled: { type: Boolean, default: false },
      code: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Rule', ruleSchema);
