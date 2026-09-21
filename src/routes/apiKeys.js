const express = require('express');
const { asyncHandler, HttpError } = require('../lib/http');
const { requireAuth, requireWorkspaceMember } = require('../middleware/auth');
const ApiKey = require('../models/ApiKey');
const Rule = require('../models/Rule');

// Mounted at /workspaces/:workspaceId/api-keys
const router = express.Router({ mergeParams: true });

router.use(requireAuth, requireWorkspaceMember);

/** GET — list workspace API keys (never returns the secret). */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const keys = await ApiKey.find({ workspace: req.workspace._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: keys.map((k) => k.toSafeJSON()) });
  })
);

/**
 * POST — issue a new key. The plaintext key is returned ONCE here and never
 * again; only its hash is stored.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const count = await ApiKey.countDocuments({ workspace: req.workspace._id });
    if (count >= 10) {
      throw new HttpError(400, 'API key limit reached. Each workspace can have a maximum of 10 API keys.');
    }

    const { name, label } = req.body || {};
    const keyName = (name || label || `API Key ${count + 1}`).trim();

    const { plain, prefix, keyHash } = ApiKey.generateKey();
    const key = await ApiKey.create({
      workspace: req.workspace._id,
      name: keyName,
      label: keyName,
      prefix,
      keyHash,
      key: plain,
      createdBy: req.user._id,
    });
    res.status(201).json({
      success: true,
      data: { ...key.toSafeJSON(), key: plain },
      message: 'API key generated successfully.',
    });
  })
);

/** PATCH /:keyId — update key name */
router.patch(
  '/:keyId',
  asyncHandler(async (req, res) => {
    const { name, label } = req.body || {};
    const key = await ApiKey.findOne({ _id: req.params.keyId, workspace: req.workspace._id });
    if (!key) throw new HttpError(404, 'API key not found');
    if (name || label) {
      key.name = (name || label).trim();
      key.label = key.name;
      await key.save();
    }
    res.json({ success: true, data: key.toSafeJSON() });
  })
);

/** GET /:keyId/reveal — reveal key for display and copying in dashboard. */
router.get(
  '/:keyId/reveal',
  asyncHandler(async (req, res) => {
    const key = await ApiKey.findOne({ _id: req.params.keyId, workspace: req.workspace._id });
    if (!key) throw new HttpError(404, 'API key not found');
    const displayName = key.name || key.label || 'Default Key';
    res.json({
      success: true,
      data: {
        id: String(key._id),
        key: key.key || `${key.prefix}••••••••`,
        prefix: key.prefix,
        name: displayName,
        label: displayName,
        revoked: key.revoked,
      },
    });
  })
);

/** POST /:keyId/revoke */
router.post(
  '/:keyId/revoke',
  asyncHandler(async (req, res) => {
    const key = await ApiKey.findOne({ _id: req.params.keyId, workspace: req.workspace._id });
    if (!key) throw new HttpError(404, 'API key not found');
    key.revoked = true;
    await key.save();
    res.json({ success: true, data: key.toSafeJSON() });
  })
);

/** DELETE /:keyId */
router.delete(
  '/:keyId',
  asyncHandler(async (req, res) => {
    const key = await ApiKey.findOne({ _id: req.params.keyId, workspace: req.workspace._id });
    if (!key) throw new HttpError(404, 'API key not found');

    const keyId = key._id;
    // Clean up all rules associated with this API key
    const rulesResult = await Rule.deleteMany({
      $or: [{ apiKey: keyId }, { apiKey: String(keyId) }],
    });

    await key.deleteOne();
    res.json({
      success: true,
      data: {
        deleted: true,
        deletedRulesCount: rulesResult.deletedCount,
      },
    });
  })
);

module.exports = router;
