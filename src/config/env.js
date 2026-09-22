/**
 * Centralized environment configuration.
 * Loads .env once and exposes a validated config object.
 */
require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] || fallback;
  if (value === undefined || value === null || value === '') {
    // eslint-disable-next-line no-console
    console.warn(`[config] Missing env var ${name} — using empty value.`);
    return '';
  }
  return value;
}

const pkg = require('../../package.json');

const config = {
  version: pkg.version || '2.0.1',
  port: parseInt(process.env.PORT || '3000', 10),
  serverBasePath: required('SERVER_BASE_PATH', process.env.NODE_ENV === 'production' ? 'https://proxytea.onrender.com' : 'http://localhost:3000'),
  mongoUri: required(
    'MONGODB_URI',
    'mongodb+srv://proxceptadmin:MONGOatflagmate2026@proxcept-clustor.unamvf3.mongodb.net/superdebug?retryWrites=true&w=majority&appName=PROXCEPT-CLUSTOR'
  ),
  jwtSecret: required('JWT_SECRET', 'dev-insecure-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  masterOtp: process.env.MASTER_OTP || '123987',
  localDomain: process.env.LOCAL_DOMAIN || 'http://localhost:3000,http://localhost:5173,http://localhost:8080,http://127.0.0.1:3000',

  productionDomain:
    process.env.PRODUCTION_DOMAIN ||
    'https://proxytea.onrender.com,https://proxytea.hatchable.site,https://proxytea.com,https://app.proxytea.com',
  corsOrigins: Array.from(
    new Set(
      [
        ...(process.env.LOCAL_DOMAIN
          ? process.env.LOCAL_DOMAIN.split(',')
          : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080', 'http://127.0.0.1:3000']),
        ...(process.env.PRODUCTION_DOMAIN
          ? process.env.PRODUCTION_DOMAIN.split(',')
          : [
              'https://proxytea.onrender.com',
              'https://proxytea.hatchable.site',
              'https://proxytea.com',
              'https://app.proxytea.com',
            ]),
        ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : []),
      ]
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    )
  ),


  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: process.env.SMTP_SECURE !== 'false',
    user: process.env.SMTP_USER || '',
    pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'ProxyTea <noreply@proxytea.com>',
  },
};

module.exports = config;
