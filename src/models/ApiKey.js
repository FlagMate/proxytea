const { mongoose } = require('../config/db');
const crypto = require('crypto');

/**
 * A workspace-scoped API key used by the SDK (and TV app) to pull the
 * workspace's active-profile rules from the public endpoint.
 *
 * Only the SHA-256 hash of the key is stored. The plaintext key is shown to the
 * user exactly once at creation time. A short non-secret prefix is stored so the
 * dashboard can display "sdm_live_ab12…" without exposing the secret.
 */
const apiKeySchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    name: { type: String, default: 'Default Key', trim: true },
    label: { type: String, default: 'Default key', trim: true },
    prefix: { type: String, required: true }, // non-secret, for display
    keyHash: { type: String, required: true, index: true },
    key: { type: String, default: '' }, // stored so workspace members can reveal/copy in the future
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastUsedAt: { type: Date, default: null },
    revoked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/** Hash a plaintext key for storage/lookup. */
apiKeySchema.statics.hashKey = function hashKey(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
};

/**
 * Generate a new plaintext key. Format: sdm_live_<32 hex chars>.
 * Returns { plain, prefix, keyHash }.
 */
apiKeySchema.statics.generateKey = function generateKey() {
  const random = crypto.randomBytes(24).toString('hex');
  const plain = `sdm_live_${random}`;
  const prefix = plain.slice(0, 16); // "sdm_live_" + 7 chars
  const keyHash = this.hashKey(plain);
  return { plain, prefix, keyHash };
};

apiKeySchema.methods.toSafeJSON = function toSafeJSON() {
  const displayName = this.name || this.label || 'Default Key';
  return {
    id: String(this._id),
    workspace: String(this.workspace),
    name: displayName,
    label: displayName,
    prefix: this.prefix,
    revoked: this.revoked,
    lastUsedAt: this.lastUsedAt,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('ApiKey', apiKeySchema);
