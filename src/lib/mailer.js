const nodemailer = require('nodemailer');
const config = require('../config/env');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { user, pass, host, port, secure } = config.smtp || {};
  if (!user || !pass) {
    console.warn('[mailer] SMTP credentials not configured. Emails will not be dispatched.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: host || 'smtp.gmail.com',
    port: port || 465,
    secure: secure !== false,
    auth: {
      user: user,
      pass: pass,
    },
  });

  return transporter;
}

/**
 * Send Magic Link / Verification Code email
 * @param {string} toEmail
 * @param {string} code 6-digit OTP code
 */
async function sendMagicCodeEmail(toEmail, code) {
  const mailClient = getTransporter();
  if (!mailClient) {
    console.log(`[mailer:simulated] Verification code for ${toEmail}: ${code}`);
    return { sent: false, reason: 'unconfigured' };
  }

  const mailOptions = {
    from: config.smtp.from || config.smtp.user,
    to: toEmail,
    subject: `Your ProxyTea Verification Code: ${code}`,
    text: `Your ProxyTea verification code is ${code}. It will expire in 10 minutes.\n\nIf you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #0f172a; border-radius: 12px; color: #f8fafc;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="margin: 0; font-size: 24px; color: #f97316; letter-spacing: -0.5px;">⚡ ProxyTea</h2>
          <p style="margin: 6px 0 0; color: #94a3b8; font-size: 14px;">Instant Network Interception & Rule Debugger</p>
        </div>
        <div style="background: #1e293b; border-radius: 8px; border: 1px solid #334155; padding: 24px; text-align: center; margin-bottom: 20px;">
          <p style="margin: 0 0 12px; color: #cbd5e1; font-size: 15px;">Use the following 6-digit code to sign in to your workspace:</p>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #38bdf8; background: #0f172a; padding: 14px 24px; border-radius: 6px; display: inline-block; border: 1px solid #0284c7; font-family: monospace;">
            ${code}
          </div>
          <p style="margin: 16px 0 0; color: #64748b; font-size: 13px;">This code expires in 10 minutes.</p>
        </div>
        <p style="color: #64748b; font-size: 12px; text-align: center; margin: 0;">
          If you didn't request this verification code, safely ignore this email.
        </p>
      </div>
    `,
  };

  try {
    const info = await mailClient.sendMail(mailOptions);
    console.log(`[mailer] Email dispatched successfully to ${toEmail}. MessageId: ${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mailer] Failed to send email to ${toEmail}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Send Password Reset OTP email
 * @param {string} toEmail
 * @param {string} code 6-digit OTP code
 */
async function sendForgotPasswordEmail(toEmail, code) {
  const mailClient = getTransporter();
  if (!mailClient) {
    console.log(`[mailer:simulated] Password reset code for ${toEmail}: ${code}`);
    return { sent: false, reason: 'unconfigured' };
  }

  const mailOptions = {
    from: config.smtp.from || config.smtp.user,
    to: toEmail,
    subject: `Your ProxyTea Password Reset Code: ${code}`,
    text: `Your ProxyTea password reset code is ${code}. It will expire in 10 minutes.\n\nIf you did not request this password reset, you can safely ignore this email.`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #0b0f19; border-radius: 12px; color: #f8fafc; border: 1px solid #1e293b;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="margin: 0; font-size: 24px; color: #f97316; letter-spacing: -0.5px;">⚡ ProxyTea</h2>
          <p style="margin: 6px 0 0; color: #94a3b8; font-size: 14px;">Password Reset Request</p>
        </div>
        <div style="background: #111827; border-radius: 8px; border: 1px solid #1f2937; padding: 24px; text-align: center; margin-bottom: 20px;">
          <p style="margin: 0 0 14px; color: #cbd5e1; font-size: 14.5px;">Use the following 6-digit verification code to reset your password:</p>
          <div style="font-size: 34px; font-weight: 800; letter-spacing: 9px; color: #10b981; background: #030712; padding: 14px 24px; border-radius: 8px; display: inline-block; border: 1px solid #059669; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
            ${code}
          </div>
          <p style="margin: 16px 0 0; color: #64748b; font-size: 12.5px;">This OTP code is valid for 10 minutes.</p>
        </div>
        <p style="color: #64748b; font-size: 12px; text-align: center; margin: 0;">
          If you didn't request a password reset, your account is safe and you can safely ignore this email.
        </p>
      </div>
    `,
  };

  try {
    const info = await mailClient.sendMail(mailOptions);
    console.log(`[mailer] Password reset email dispatched successfully to ${toEmail}. MessageId: ${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mailer] Failed to send password reset email to ${toEmail}:`, err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  getTransporter,
  sendMagicCodeEmail,
  sendForgotPasswordEmail,
};
