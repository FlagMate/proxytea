# ProxyTea Production Backend (Render CI/CD)

Production deploy artifact generated from SuperDebugMode / ProxyTea monorepo.
This branch (`PRODUCTION_DEPLOY`) is automatically tracked by Render.

## Deployment on Render:
1. Connect repository `https://github.com/FlagMate/proxytea` on [Render Dashboard](https://dashboard.render.com).
2. Select branch: **`PRODUCTION_DEPLOY`**.
3. Set Environment: **Node**.
4. Build Command: `npm install --omit=dev`
5. Start Command: `node server.js`
6. Environment Variables to configure in Render Dashboard:
   - `MONGODB_URI`: Your production MongoDB connection string (e.g. MongoDB Atlas).
   - `JWT_SECRET`: Secure random string for JWT signing.
   - `PRODUCTION_DOMAIN`: Comma-separated allowed frontend domains (e.g. `https://proxytea.hatchable.site`).
