const express = require('express');
const { asyncHandler, HttpError } = require('../lib/http');
const { requireAuth, requireWorkspaceMember, requireWorkspaceOwner } = require('../middleware/auth');
const Workspace = require('../models/Workspace');
const Profile = require('../models/Profile');
const Rule = require('../models/Rule');
const ApiKey = require('../models/ApiKey');
const User = require('../models/User');

const router = express.Router();

router.use(requireAuth);

/** GET /workspaces — all workspaces the user belongs to (members populated). */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const uid = req.user._id;
    const workspaces = await Workspace.find({
      $or: [{ owner: uid }, { 'members.user': uid }],
    })
      .populate('members.user', 'email name')
      .sort({ updatedAt: -1 });
    res.json({ success: true, data: workspaces.map((w) => w.toJSONSafe()) });
  })
);

/** POST /workspaces — create a workspace (+ a Default profile). */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) throw new HttpError(400, 'Workspace name is required');

    const uid = req.user._id;
    const existingCount = await Workspace.countDocuments({ owner: uid });
    if (existingCount >= 5) {
      throw new HttpError(400, 'Workspace limit reached. Each account can create a maximum of 5 workspaces.');
    }

    const workspace = await Workspace.create({
      name: name.trim(),
      owner: req.user._id,
      members: [{ user: req.user._id, role: 'owner' }],
    });
    const profile = await Profile.create({
      workspace: workspace._id,
      name: 'Default',
      description: 'Default rule profile',
    });
    workspace.activeProfile = profile._id;
    await workspace.save();

    // Auto-create initial default API key for the new workspace
    try {
      const { plain, prefix, keyHash } = ApiKey.generateKey();
      await ApiKey.create({
        workspace: workspace._id,
        name: 'Default Key',
        label: 'Default Key',
        prefix,
        keyHash,
        key: plain,
        createdBy: req.user._id,
      });
    } catch (err) {
      // Non-fatal if default key creation encounters issue
    }

    res.status(201).json({ success: true, data: workspace.toJSONSafe() });
  })
);

/** GET /workspaces/:workspaceId (members populated) */
router.get(
  '/:workspaceId',
  requireWorkspaceMember,
  asyncHandler(async (req, res) => {
    await req.workspace.populate('members.user', 'email name');
    res.json({ success: true, data: req.workspace.toJSONSafe() });
  })
);

/** PATCH /workspaces/:workspaceId — rename or set active profile. */
router.patch(
  '/:workspaceId',
  requireWorkspaceMember,
  asyncHandler(async (req, res) => {
    const { name, activeProfile } = req.body || {};
    if (typeof name === 'string' && name.trim()) req.workspace.name = name.trim();
    if (activeProfile) {
      const profile = await Profile.findOne({
        _id: activeProfile,
        workspace: req.workspace._id,
      });
      if (!profile) throw new HttpError(400, 'activeProfile must be a profile in this workspace');
      req.workspace.activeProfile = profile._id;
    }
    await req.workspace.save();
    res.json({ success: true, data: req.workspace.toJSONSafe() });
  })
);

/** DELETE /workspaces/:workspaceId — owner only; cascades profiles/rules/keys. */
router.delete(
  '/:workspaceId',
  requireWorkspaceMember,
  requireWorkspaceOwner,
  asyncHandler(async (req, res) => {
    const wid = req.workspace._id;

    // 1. Gather all API keys and profiles belonging to this workspace
    const [keys, profs] = await Promise.all([
      ApiKey.find({ workspace: wid }, '_id'),
      Profile.find({ workspace: wid }, '_id'),
    ]);
    const keyIds = keys.map((k) => k._id);
    const keyIdStrings = keys.map((k) => String(k._id));
    const profIds = profs.map((p) => p._id);

    // 2. Cascade delete all rules, profiles, and API keys
    const [rulesDeleted, profilesDeleted, keysDeleted] = await Promise.all([
      Rule.deleteMany({
        $or: [
          { workspace: wid },
          { apiKey: { $in: [...keyIds, ...keyIdStrings] } },
          { profile: { $in: profIds } },
        ],
      }),
      Profile.deleteMany({ workspace: wid }),
      ApiKey.deleteMany({ workspace: wid }),
    ]);

    // 3. Delete the workspace document
    await req.workspace.deleteOne();

    res.json({
      success: true,
      data: {
        deleted: true,
        deletedRulesCount: rulesDeleted.deletedCount,
        deletedProfilesCount: profilesDeleted.deletedCount,
        deletedKeysCount: keysDeleted.deletedCount,
      },
    });
  })
);

/** POST /workspaces/:workspaceId/members — owner adds a member by email. */
router.post(
  '/:workspaceId/members',
  requireWorkspaceMember,
  requireWorkspaceOwner,
  asyncHandler(async (req, res) => {
    const { email, role } = req.body || {};
    if (!email) throw new HttpError(400, 'email is required');
    if (req.workspace.members && req.workspace.members.length >= 5) {
      throw new HttpError(400, 'Member limit reached. Each workspace can have a maximum of 5 members.');
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) throw new HttpError(404, 'No user with that email');

    const uid = String(user._id);
    if (req.workspace.members.some((m) => String(m.user) === uid)) {
      throw new HttpError(409, 'User is already a member');
    }
    req.workspace.members.push({ user: user._id, role: role === 'owner' ? 'owner' : 'member' });
    await req.workspace.save();
    await req.workspace.populate('members.user', 'email name');
    res.status(201).json({ success: true, data: req.workspace.toJSONSafe() });
  })
);

/** PATCH /:workspaceId/members/:userId — owner changes a member's role. */
router.patch(
  '/:workspaceId/members/:userId',
  requireWorkspaceMember,
  requireWorkspaceOwner,
  asyncHandler(async (req, res) => {
    const { role } = req.body || {};
    if (role !== 'owner' && role !== 'member') {
      throw new HttpError(400, "role must be 'owner' or 'member'");
    }
    const targetId = String(req.params.userId);
    const member = req.workspace.members.find((m) => String(m.user) === targetId);
    if (!member) throw new HttpError(404, 'Member not found in this workspace');

    // Guard: don't allow demoting the last owner (workspace.owner or role owners).
    if (member.role === 'owner' && role === 'member') {
      const owners = req.workspace.members.filter((m) => m.role === 'owner').length;
      if (owners <= 1) throw new HttpError(400, 'A workspace must keep at least one owner');
    }
    member.role = role;
    // Note: this grants/revokes the co-owner permission. The primary
    // workspace.owner pointer is only changed via explicit ownership transfer.
    await req.workspace.save();
    await req.workspace.populate('members.user', 'email name');
    res.json({ success: true, data: req.workspace.toJSONSafe() });
  })
);

/** DELETE /:workspaceId/members/:userId — owner removes a member. */
router.delete(
  '/:workspaceId/members/:userId',
  requireWorkspaceMember,
  requireWorkspaceOwner,
  asyncHandler(async (req, res) => {
    const targetId = String(req.params.userId);
    const member = req.workspace.members.find((m) => String(m.user) === targetId);
    if (!member) throw new HttpError(404, 'Member not found in this workspace');

    if (targetId === String(req.workspace.owner)) {
      throw new HttpError(400, 'Cannot remove the workspace owner. Transfer ownership first.');
    }
    req.workspace.members = req.workspace.members.filter((m) => String(m.user) !== targetId);
    await req.workspace.save();
    await req.workspace.populate('members.user', 'email name');
    res.json({ success: true, data: req.workspace.toJSONSafe() });
  })
);

module.exports = router;
