const express = require('express');
const { asyncHandler, HttpError } = require('../lib/http');
const { requireAuth, requireWorkspaceMember } = require('../middleware/auth');
const Profile = require('../models/Profile');
const Rule = require('../models/Rule');
const { normalizeRule, normalizeRules, toProxyRule } = require('../lib/ruleSchema');

// Mounted at /workspaces/:workspaceId/profiles/:profileId/rules
const router = express.Router({ mergeParams: true });

router.use(requireAuth, requireWorkspaceMember);

/** Resolve the profile and confirm it belongs to the workspace. */
async function loadProfile(req) {
  if (req.params.profileId) {
    const profile = await Profile.findOne({
      _id: req.params.profileId,
      workspace: req.workspace._id,
    });
    if (!profile) throw new HttpError(404, 'Profile not found');
    return profile;
  }
  if (req.workspace.activeProfile) {
    const profile = await Profile.findOne({
      _id: req.workspace.activeProfile,
      workspace: req.workspace._id,
    });
    if (profile) return profile;
  }
  let profile = await Profile.findOne({ workspace: req.workspace._id });
  if (!profile) {
    profile = await Profile.create({
      workspace: req.workspace._id,
      name: 'Default',
      description: 'Default rule profile',
    });
    req.workspace.activeProfile = profile._id;
    await req.workspace.save();
  }
  return profile;
}

/** Next priority = max existing + 1 (keeps priorities distinct, mirrors extension). */
async function nextPriority(profileId, workspaceId) {
  const query = profileId ? { profile: profileId } : { workspace: workspaceId };
  const top = await Rule.findOne(query).sort({ priority: -1 });
  return top && typeof top.priority === 'number' ? top.priority + 1 : 1;
}

/** GET — list rules as ProxyRule wire shape. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    let filter = { workspace: req.workspace._id };
    const apiKey = req.query.apiKey || req.params.apiKeyId;
    if (apiKey) {
      filter.apiKey = apiKey;
    } else if (req.params.profileId) {
      const profile = await loadProfile(req);
      filter.profile = profile._id;
    } else if (req.query.profileId) {
      filter.profile = req.query.profileId;
    }
    const rules = await Rule.find(filter).sort({ priority: 1, createdAt: 1 });
    res.json({ success: true, data: rules.map(toProxyRule) });
  })
);

/** POST — create a rule. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const profile = await loadProfile(req);
    const norm = normalizeRule({ name: 'New Rule', ...(req.body || {}) });
    if (!norm) throw new HttpError(400, 'Rule name is required');
    if (norm.priority === null) norm.priority = await nextPriority(profile?._id, req.workspace._id);

    const apiKeyId = req.body?.apiKey || req.query?.apiKey || req.params?.apiKeyId || null;

    const rule = await Rule.create({
      ...norm,
      apiKey: apiKeyId,
      profile: profile ? profile._id : null,
      workspace: req.workspace._id,
    });
    res.status(201).json({ success: true, data: toProxyRule(rule) });
  })
);

/** PUT /:ruleId — full update. */
router.put(
  '/:ruleId',
  asyncHandler(async (req, res) => {
    const query = { _id: req.params.ruleId, workspace: req.workspace._id };
    if (req.params.profileId) query.profile = req.params.profileId;
    const rule = await Rule.findOne(query);
    if (!rule) throw new HttpError(404, 'Rule not found');

    const norm = normalizeRule({ name: rule.name, ...(req.body || {}) });
    if (!norm) throw new HttpError(400, 'Rule name is required');
    if (norm.priority === null) norm.priority = rule.priority;

    Object.assign(rule, norm);
    if (req.body && req.body.apiKey !== undefined) {
      rule.apiKey = req.body.apiKey;
    }
    await rule.save();
    res.json({ success: true, data: toProxyRule(rule) });
  })
);

/** DELETE /:ruleId */
router.delete(
  '/:ruleId',
  asyncHandler(async (req, res) => {
    const query = { _id: req.params.ruleId, workspace: req.workspace._id };
    if (req.params.profileId) query.profile = req.params.profileId;
    const result = await Rule.deleteOne(query);
    if (result.deletedCount === 0) throw new HttpError(404, 'Rule not found');
    res.json({ success: true, data: { deleted: true } });
  })
);

/** POST /:ruleId/duplicate */
router.post(
  '/:ruleId/duplicate',
  asyncHandler(async (req, res) => {
    const profile = await loadProfile(req);
    const query = { _id: req.params.ruleId, workspace: req.workspace._id };
    if (req.params.profileId) query.profile = req.params.profileId;
    const src = await Rule.findOne(query);
    if (!src) throw new HttpError(404, 'Rule not found');
    const obj = toProxyRule(src);
    delete obj.id;
    obj.name = `${obj.name} (copy)`;
    obj.priority = await nextPriority(profile?._id, req.workspace._id);
    const copy = await Rule.create({
      ...normalizeRule(obj),
      priority: obj.priority,
      apiKey: src.apiKey || null,
      profile: profile ? profile._id : null,
      workspace: req.workspace._id,
    });
    res.status(201).json({ success: true, data: toProxyRule(copy) });
  })
);

/**
 * POST /import — bulk import an array of ProxyRule-shaped objects (from the
 * extension's Export, a CDN file, or Charles/Fiddler conversions). Local rules
 * are appended; names are the merge identity but duplicates are allowed here.
 */
router.post(
  '/import',
  asyncHandler(async (req, res) => {
    const profile = await loadProfile(req);
    const incoming = Array.isArray(req.body) ? req.body : req.body && req.body.rules;
    const normalized = normalizeRules(incoming);
    if (normalized.length === 0) throw new HttpError(400, 'No usable rules to import');

    const apiKeyId = req.body?.apiKey || req.query?.apiKey || req.params?.apiKeyId || null;
    let priority = await nextPriority(profile?._id, req.workspace._id);
    const docs = normalized.map((r) => ({
      ...r,
      priority: typeof r.priority === 'number' ? r.priority : priority++,
      apiKey: r.apiKey || apiKeyId,
      profile: profile ? profile._id : null,
      workspace: req.workspace._id,
    }));
    const created = await Rule.insertMany(docs);
    res.status(201).json({ success: true, data: created.map(toProxyRule) });
  })
);

/** GET /export — the profile's rules as a plain ProxyRule[] array (extension import format). */
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    let filter = { workspace: req.workspace._id };
    const apiKey = req.query.apiKey || req.params.apiKeyId;
    if (apiKey) {
      filter.apiKey = apiKey;
    } else if (req.params.profileId) {
      const profile = await loadProfile(req);
      filter.profile = profile._id;
    }
    const rules = await Rule.find(filter).sort({ priority: 1 });
    res.json(rules.map(toProxyRule));
  })
);

module.exports = router;
