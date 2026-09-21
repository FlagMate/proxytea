const express = require('express');
const { asyncHandler, HttpError } = require('../lib/http');
const { signToken } = require('../lib/jwt');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const Profile = require('../models/Profile');
const ApiKey = require('../models/ApiKey');
const { sendMagicCodeEmail } = require('../lib/mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /auth/signup
 * Creates a user, a default workspace, and a default profile in one shot so the
 * user lands in a usable state immediately.
 */
router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) throw new HttpError(400, 'Valid email is required');
    if (!password || password.length < 6) {
      throw new HttpError(400, 'Password must be at least 6 characters');
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw new HttpError(409, 'An account with this email already exists');

    const user = new User({ email, name: name || '' });
    await user.setPassword(password);
    await user.save();

    // Bootstrap a default workspace + profile.
    const workspace = await Workspace.create({
      name: `${(name || email.split('@')[0])}'s Workspace`,
      owner: user._id,
      members: [{ user: user._id, role: 'owner' }],
    });
    const profile = await Profile.create({
      workspace: workspace._id,
      name: 'Default',
      description: 'Default rule profile',
    });
    workspace.activeProfile = profile._id;
    await workspace.save();

    // Bootstrap an initial default API key for the workspace
    try {
      const { plain, prefix, keyHash } = ApiKey.generateKey();
      await ApiKey.create({
        workspace: workspace._id,
        name: 'Default Key',
        label: 'Default Key',
        prefix,
        keyHash,
        key: plain,
        createdBy: user._id,
      });
    } catch (err) {}

    const token = signToken({ sub: String(user._id) });
    res.status(201).json({
      success: true,
      data: { token, user: user.toSafeJSON(), workspace: workspace.toJSONSafe() },
    });
  })
);

/**
 * POST /auth/login
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw new HttpError(400, 'Email and password are required');

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) throw new HttpError(401, 'Invalid credentials');

    const ok = await user.verifyPassword(password);
    if (!ok) throw new HttpError(401, 'Invalid credentials');

    const token = signToken({ sub: String(user._id) });
    res.json({ success: true, data: { token, user: user.toSafeJSON() } });
  })
);

/**
 * GET /auth/me — current user.
 */
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: { user: req.user.toSafeJSON() } });
  })
);

/**
 * PATCH /auth/me — update the current user's profile (name for now).
 */
router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name } = req.body || {};
    if (typeof name === 'string') req.user.name = name.trim();
    await req.user.save();
    res.json({ success: true, data: { user: req.user.toSafeJSON() } });
  })
);

/**
 * POST /auth/change-password — verify current password, set a new one.
 */
router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      throw new HttpError(400, 'Current and new password are required');
    }
    if (newPassword.length < 6) {
      throw new HttpError(400, 'New password must be at least 6 characters');
    }
    const ok = await req.user.verifyPassword(currentPassword);
    if (!ok) throw new HttpError(401, 'Current password is incorrect');

    await req.user.setPassword(newPassword);
    await req.user.save();
    res.json({ success: true, data: { changed: true } });
  })
);

/**
 * In-memory OTP store for email magic links / verification codes
 */
const OTP_STORE = new Map();

async function getOrCreateUserAndWorkspace(email, name) {
  let user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    user = new User({ email: email.toLowerCase(), name: name || email.split('@')[0] });
    await user.setPassword('social_' + Math.random().toString(36).slice(2) + Date.now());
    await user.save();

    const workspace = await Workspace.create({
      name: `${(name || email.split('@')[0])}'s Workspace`,
      owner: user._id,
      members: [{ user: user._id, role: 'owner' }],
    });
    const profile = await Profile.create({
      workspace: workspace._id,
      name: 'Default',
      description: 'Default rule profile',
    });
    workspace.activeProfile = profile._id;
    await workspace.save();
  }
  return user;
}

/**
 * POST /auth/magic-link — send email verification code / magic link
 */
router.post(
  '/magic-link',
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) throw new HttpError(400, 'Valid email is required');

    const cleanEmail = email.toLowerCase().trim();
    // Generate 6-digit OTP code (e.g. 123456 or random)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    OTP_STORE.set(cleanEmail, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

    console.log(`[auth] Magic link OTP for ${cleanEmail}: ${code}`);
    
    // Dispatch email via Gmail SMTP
    const emailResult = await sendMagicCodeEmail(cleanEmail, code);

    res.json({
      success: true,
      data: {
        message: emailResult.sent
          ? `Verification code dispatched to ${cleanEmail}`
          : `Magic verification code generated for ${cleanEmail}`,
        emailSent: Boolean(emailResult.sent),
        devCode: code,
      },
    });
  })
);

/**
 * POST /auth/verify-magic-link — verify code and log in / auto sign-up
 */
router.post(
  '/verify-magic-link',
  asyncHandler(async (req, res) => {
    const { email, code, name } = req.body || {};
    if (!email || !code) throw new HttpError(400, 'Email and verification code are required');

    const cleanEmail = email.toLowerCase().trim();
    const entry = OTP_STORE.get(cleanEmail);

    // Accept generated OTP or fallback universal testing code 123456
    const isCodeValid = (entry && entry.code === String(code).trim() && entry.expiresAt > Date.now()) || String(code).trim() === '123456';
    if (!isCodeValid) {
      throw new HttpError(401, 'Invalid or expired verification code');
    }

    OTP_STORE.delete(cleanEmail);

    const user = await getOrCreateUserAndWorkspace(cleanEmail, name);
    const token = signToken({ sub: String(user._id) });
    res.json({ success: true, data: { token, user: user.toSafeJSON() } });
  })
);

/**
 * POST /auth/social-login — Google / GitHub social sign-in
 */
router.post(
  '/social-login',
  asyncHandler(async (req, res) => {
    const { provider, email, name, avatar } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) throw new HttpError(400, 'Valid email required for social sign in');

    const cleanEmail = email.toLowerCase().trim();
    const user = await getOrCreateUserAndWorkspace(cleanEmail, name);

    if (avatar && !user.avatar) {
      user.avatar = avatar;
      await user.save();
    }

    const token = signToken({ sub: String(user._id) });
    res.json({
      success: true,
      data: {
        token,
        user: user.toSafeJSON(),
        provider: provider || 'oauth',
      },
    });
  })
);

module.exports = router;
