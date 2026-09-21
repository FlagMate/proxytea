const { verifyToken } = require('../lib/jwt');
const { HttpError } = require('../lib/http');
const User = require('../models/User');
const Workspace = require('../models/Workspace');

/**
 * requireAuth — verifies the Bearer JWT and attaches req.user.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Authentication required');

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (e) {
      throw new HttpError(401, 'Invalid or expired token');
    }

    const user = await User.findById(decoded.sub);
    if (!user) throw new HttpError(401, 'User no longer exists');

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * requireWorkspaceMember — ensures req.user is a member of the workspace given
 * by :workspaceId (or req.body.workspace). Attaches req.workspace and req.role.
 * Must run after requireAuth.
 */
async function requireWorkspaceMember(req, res, next) {
  try {
    const workspaceId =
      req.params.workspaceId || req.body.workspace || req.query.workspace;
    if (!workspaceId) throw new HttpError(400, 'workspaceId is required');

    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) throw new HttpError(404, 'Workspace not found');

    const uid = String(req.user._id);
    const membership = workspace.members.find((m) => String(m.user) === uid);
    if (!membership && String(workspace.owner) !== uid) {
      throw new HttpError(403, 'You are not a member of this workspace');
    }

    req.workspace = workspace;
    req.role = membership ? membership.role : 'owner';
    next();
  } catch (err) {
    next(err);
  }
}

/** requireWorkspaceOwner — must run after requireWorkspaceMember. */
function requireWorkspaceOwner(req, res, next) {
  if (req.role !== 'owner') {
    return next(new HttpError(403, 'Owner role required for this action'));
  }
  next();
}

module.exports = { requireAuth, requireWorkspaceMember, requireWorkspaceOwner };
