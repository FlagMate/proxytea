const { mongoose } = require('../config/db');

/**
 * A Profile is a named set of rules within a workspace (e.g. "SonyLIV Debug",
 * "Payment Testing"). A workspace's activeProfile is what the SDK/extension pull.
 */
const profileSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
  },
  { timestamps: true }
);

profileSchema.methods.toJSONSafe = function toJSONSafe() {
  return {
    id: String(this._id),
    workspace: String(this.workspace),
    name: this.name,
    description: this.description,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('Profile', profileSchema);
