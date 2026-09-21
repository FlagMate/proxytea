const express = require('express');
const { asyncHandler, HttpError } = require('../lib/http');
const { requireAuth, requireWorkspaceMember } = require('../middleware/auth');
const Profile = require('../models/Profile');
const Rule = require('../models/Rule');
const Workspace = require('../models/Workspace');

// Mounted at /workspaces/:workspaceId/profiles
const router = express.Router({ mergeParams: true });

router.use(requireAuth, requireWorkspaceMember);

/** GET — list profiles in the workspace. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const profiles = await Profile.find({ workspace: req.workspace._id }).sort({ createdAt: 1 });
    res.json({ success: true, data: profiles.map((p) => p.toJSONSafe()) });
  })
);

/** POST — create a profile. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) throw new HttpError(400, 'Profile name is required');
    const profile = await Profile.create({
      workspace: req.workspace._id,
      name: name.trim(),
      description: description || '',
    });
    res.status(201).json({ success: true, data: profile.toJSONSafe() });
  })
);

/** GET /:profileId */
router.get(
  '/:profileId',
  asyncHandler(async (req, res) => {
    const profile = await Profile.findOne({
      _id: req.params.profileId,
      workspace: req.workspace._id,
    });
    if (!profile) throw new HttpError(404, 'Profile not found');
    res.json({ success: true, data: profile.toJSONSafe() });
  })
);

/** PATCH /:profileId — rename / update description. */
router.patch(
  '/:profileId',
  asyncHandler(async (req, res) => {
    const profile = await Profile.findOne({
      _id: req.params.profileId,
      workspace: req.workspace._id,
    });
    if (!profile) throw new HttpError(404, 'Profile not found');
    const { name, description } = req.body || {};
    if (typeof name === 'string' && name.trim()) profile.name = name.trim();
    if (typeof description === 'string') profile.description = description;
    await profile.save();
    res.json({ success: true, data: profile.toJSONSafe() });
  })
);

/** POST /:profileId/duplicate — clone a profile and all its rules. */
router.post(
  '/:profileId/duplicate',
  asyncHandler(async (req, res) => {
    const src = await Profile.findOne({
      _id: req.params.profileId,
      workspace: req.workspace._id,
    });
    if (!src) throw new HttpError(404, 'Profile not found');

    const copy = await Profile.create({
      workspace: req.workspace._id,
      name: `${src.name} (copy)`,
      description: src.description,
    });

    // Clone the source profile's rules into the new profile.
    const srcRules = await Rule.find({ profile: src._id }).sort({ priority: 1 });
    if (srcRules.length) {
      const docs = srcRules.map((r) => {
        const obj = r.toObject();
        delete obj._id;
        delete obj.id;
        delete obj.createdAt;
        delete obj.updatedAt;
        return { ...obj, profile: copy._id, workspace: req.workspace._id };
      });
      await Rule.insertMany(docs);
    }
    res.status(201).json({ success: true, data: copy.toJSONSafe() });
  })
);

/** POST /:profileId/activate — make this the workspace's active profile. */
router.post(
  '/:profileId/activate',
  asyncHandler(async (req, res) => {
    const profile = await Profile.findOne({
      _id: req.params.profileId,
      workspace: req.workspace._id,
    });
    if (!profile) throw new HttpError(404, 'Profile not found');
    req.workspace.activeProfile = profile._id;
    await req.workspace.save();
    res.json({ success: true, data: req.workspace.toJSONSafe() });
  })
);

/** DELETE /:profileId — cannot delete the last profile; cascades its rules. */
router.delete(
  '/:profileId',
  asyncHandler(async (req, res) => {
    const profile = await Profile.findOne({
      _id: req.params.profileId,
      workspace: req.workspace._id,
    });
    if (!profile) throw new HttpError(404, 'Profile not found');

    const count = await Profile.countDocuments({ workspace: req.workspace._id });
    if (count <= 1) throw new HttpError(400, 'Cannot delete the only profile in a workspace');

    await Rule.deleteMany({ profile: profile._id });
    await profile.deleteOne();

    // If it was active, fall back to another profile.
    if (String(req.workspace.activeProfile) === String(profile._id)) {
      const fallback = await Profile.findOne({ workspace: req.workspace._id }).sort({ createdAt: 1 });
      req.workspace.activeProfile = fallback ? fallback._id : null;
      await req.workspace.save();
    }
    res.json({ success: true, data: { deleted: true } });
  })
);

module.exports = router;
