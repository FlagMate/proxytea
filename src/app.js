const express = require('express');
const cors = require('cors');
const config = require('./config/env');

const authRoutes = require('./routes/auth');
const workspaceRoutes = require('./routes/workspaces');
const profileRoutes = require('./routes/profiles');
const ruleRoutes = require('./routes/rules');
const apiKeyRoutes = require('./routes/apiKeys');
const publicRoutes = require('./routes/public');
const proxyRoutes = require('./routes/proxy');
const mitmRoutes = require('./routes/mitm');
const { notFound, errorHandler } = require('./middleware/error');
const { mongoose } = require('./config/db');

function createApp() {
  const app = express();

  // Transparent Server-Side MITM Reverse Proxy Route (accepts x-target-url or ?url=)
  // Mounted before global express.json() to preserve raw streams & binary buffers.
  const mitmCors = cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], allowedHeaders: ['*'], exposedHeaders: ['*'] });
  app.options(['/mitm', '/mitm/*', '/api/mitm', '/api/mitm/*', '/server/mitm', '/server/mitm/*'], mitmCors);
  app.use(['/mitm', '/mitm/*', '/api/mitm', '/api/mitm/*', '/server/mitm', '/server/mitm/*'], mitmCors, mitmRoutes);

  app.use(express.json({ limit: '5mb' }));

  // Dashboard CORS: restrict to configured web origins (LOCAL_DOMAIN, PRODUCTION_DOMAIN, CORS_ORIGINS).
  const dashboardCors = cors({
    origin(origin, cb) {
      // Allow same-origin / tools with no Origin header (curl, server-to-server).
      if (!origin) return cb(null, true);
      const normalizedOrigin = origin.replace(/\/+$/, '');
      if (
        config.corsOrigins.includes(normalizedOrigin) ||
        config.corsOrigins.includes(origin) ||
        config.corsOrigins.includes('*') ||
        /^https:\/\/[a-z0-9-]+\.hatchable\.site$/.test(normalizedOrigin) ||
        /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(normalizedOrigin) ||
        normalizedOrigin.endsWith('.onrender.com')
      ) {
        return cb(null, true);
      }

      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  });


  // Public SDK/extension endpoints: open CORS (any origin, X-API-Key header).
  const publicCors = cors({ origin: '*', methods: ['GET'], allowedHeaders: ['X-API-Key', 'Content-Type'] });

  // Health check: open CORS so the dashboard's connection indicator can read it
  // from any dev origin (it carries no secrets). Always returns 200 so deployment probes succeed.
  app.get(['/health', '/api/health'], publicCors, (req, res) => {
    const dbState = ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';
    res.json({
      success: true,
      data: {
        status: 'ok',
        version: config.version,
        serverBasePath: config.serverBasePath,
        database: dbState,
      },
    });
  });


  // Public routes first, with their own permissive CORS.
  app.use('/public', publicCors, publicRoutes);

  // Dumb CORS Proxy forwarder route for Curl Commander and test clients.
  const proxyCors = cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] });
  app.options(['/proxy', '/proxy/*', '/api/proxy', '/api/proxy/*'], proxyCors);
  app.use('/proxy', proxyCors, proxyRoutes);
  app.use('/api/proxy', proxyCors, proxyRoutes);

  // Authenticated dashboard routes (supports both direct and /api/ prefixes)
  app.use(['/auth', '/api/auth', '/api/account'], dashboardCors, authRoutes);
  app.use(['/workspaces', '/api/workspaces'], dashboardCors, workspaceRoutes);
  app.use(['/workspaces/:workspaceId/profiles', '/api/workspaces/:workspaceId/profiles'], dashboardCors, profileRoutes);
  app.use(['/workspaces/:workspaceId/profiles/:profileId/rules', '/api/workspaces/:workspaceId/profiles/:profileId/rules'], dashboardCors, ruleRoutes);
  app.use(['/workspaces/:workspaceId/rules', '/api/workspaces/:workspaceId/rules'], dashboardCors, ruleRoutes);
  app.use(['/workspaces/:workspaceId/api-keys', '/api/workspaces/:workspaceId/api-keys'], dashboardCors, apiKeyRoutes);
  app.use(['/public', '/api/public'], publicCors, publicRoutes);

  // Static deployments mounted under backend/public/
  const path = require('path');
  const fs = require('fs');
  const publicRoot = path.join(__dirname, '../public');
  const landingPublic = path.join(publicRoot, 'landing');
  const landingIndex = path.join(landingPublic, 'index.html');

  // Sub-app static mounts (/app, /test, /demo, /sdk, /landing)
  ['app', 'test', 'demo', 'sdk', 'landing'].forEach((dir) => {
    const dirPath = path.join(publicRoot, dir);
    app.use(`/${dir}`, express.static(dirPath));
  });

  // Direct root static assets for landing (assets/, favicon.svg, etc.)
  app.use(express.static(landingPublic));

  // Root static fallback for SDK scripts (e.g. /superdebug.min.js requested from root)
  app.use(express.static(path.join(publicRoot, 'sdk')));

  // SPA fallbacks for sub-apps (/app, /test, /landing)
  ['app', 'test', 'landing'].forEach((dir) => {
    const indexPath = path.join(publicRoot, dir, 'index.html');
    app.get([`/${dir}`, `/${dir}/*`], (req, res, next) => {
      if (path.extname(req.path)) return next();
      if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
      next();
    });
  });

  // Landing site at root: GET /, /login, /signup directly without redirection
  app.get(['/', '/login', '/signup'], (req, res, next) => {
    if (fs.existsSync(landingIndex)) {
      return res.sendFile(landingIndex);
    }
    next();
  });


  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };

