# Deploying RMS to Render

This repository includes a `render.yaml` Blueprint and `.node-version` (`22.22.3` for Node's built-in `node:sqlite` driver) so you can deploy RMS directly to Render as a single-instance web service.

## Option A — Production Blueprint (recommended, persistent SQLite disk)

Because SQLite stores all platform and restaurant databases on local disk (`RMS_DATA_DIR=/var/data`), a Render **Starter** (or higher) web service with a Persistent Disk is required to preserve data across deploys and restarts.

1. Push your branch/repo to GitHub.
2. In the Render Dashboard, click **New + → Blueprint** and connect your `RMS` repository.
3. Render automatically reads `render.yaml`:
   - **Runtime**: Node `22.22.3` (`.node-version`)
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm run start` (`scripts/start-standalone.sh`)
   - **Health Check**: `/api/health`
   - **Persistent Disk**: `1 GB` mounted at `/var/data` (`RMS_DATA_DIR=/var/data`)
   - **Generated Secrets**: `RMS_SECRET_KEY` and `RMS_SETUP_TOKEN`
4. Click **Apply** to deploy.
5. Once live, open the **Environment** tab in your Render service to copy the generated `RMS_SETUP_TOKEN`.
6. Open `https://<your-service>.onrender.com/platform` in your browser, create the **Platform Owner** account using `RMS_SETUP_TOKEN`, and provision your restaurant (which gives you the restaurant code, `/login` link, and initial admin PIN).
7. Remove or clear `RMS_SETUP_TOKEN` in Render's **Environment** tab after setup completes (Render will redeploy once cleanly without changing `/var/data`).

> **Important:** Keep Render instance scaling at **1 instance** (`max: 1`, no autoscaling). SQLite supports a single writer per file on one persistent disk.

## Option B — Quick Demo Preview on Render Free Tier (ephemeral storage)

If you just want to test the UI/QR workflow on Render's **Free** tier without attaching a persistent disk (data resets when the free service spins down or redeploys):

1. In Render Dashboard, click **New + → Web Service** (instead of Blueprint) and select your GitHub repo.
2. Set:
   - **Runtime**: `Node`
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm run start`
   - **Health Check Path**: `/api/health`
3. Add Environment Variables:
   - `NODE_ENV=production`
   - `RMS_ENV=demo`
   - `RMS_DATA_DIR=/tmp/rms-data`
   - `NEXT_TELEMETRY_DISABLED=1`
4. Deploy! Demo mode automatically seeds the sample restaurant `terai-kitchen` (staff PIN `2468`, platform login `owner@rms.local` / `rms-super-admin`, and guest table QR links such as `/t/t5`).

## Option C — Docker on Render

If you prefer Docker (`Dockerfile`), set **Environment** to `Docker`, mount a disk at `/data`, set `RMS_ENV=production`, `RMS_DATA_DIR=/data`, and generate `RMS_SECRET_KEY` and `RMS_SETUP_TOKEN`. The container automatically listens on Render's `$PORT` and checks `/api/health`.
