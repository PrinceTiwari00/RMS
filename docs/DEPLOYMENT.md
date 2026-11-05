# Single-instance AWS deployment

This baseline runs **one Next.js container, one Nginx proxy, and one SQLite
writer** on an EC2 instance. It is suitable for a single restaurant or a careful
pilot. It is not a horizontally scalable or certified card-processing deployment.

## 1. Architecture and prerequisites

- Ubuntu 24.04 LTS on EC2 (a small burstable instance is enough for an initial
  pilot; size from real order/KDS load).
- An encrypted EBS root or data volume with regular EBS snapshots. Keep SQLite on
  local EBS storage, **not** EFS/NFS.
- Docker Engine with the Compose plugin, Nginx, Certbot, and Node.js 22.5+ on the
  host for the backup job.
- A DNS record for the restaurant domain and an EC2 security group allowing only
  80/443 publicly. Restrict SSH to administrator addresses.
- Optional: an EC2 IAM role that can write to a private S3 backup bucket. Do not
  put long-lived AWS keys in `.env`.

Only the `rms` container runs the application. Do not increase its replica count,
run a second container against the same database, or deploy this SQLite build to
serverless/shared filesystem platforms.

## 2. Install and configure

Install Docker using Docker's official Ubuntu repository, then:

```bash
sudo mkdir -p /opt/rms
sudo chown "$USER":"$USER" /opt/rms
git clone https://github.com/PrinceTiwari00/RMS.git /opt/rms
cd /opt/rms
# Deploy a reviewed commit/tag rather than an unreviewed moving branch.

umask 077
cp .env.example .env
openssl rand -base64 48   # paste the first value as RMS_SECRET_KEY
openssl rand -base64 48   # paste a different value as RMS_SETUP_TOKEN
```

Edit `.env`:

- `RMS_SECRET_KEY`: stable, random, at least 32 characters. Changing it signs out
  every session. Never reuse the development fallback or commit this value.
- `RMS_SETUP_TOKEN`: a different random, one-time deployment secret. It is pasted
  into the browser only during initial setup; it is never included in a URL.
- `RMS_DATA_DIR`: normally `./data`, mounted at `/data` in the container.

Start with a **new empty production data directory**. Production migration never
seeds demo staff, menu items, orders, or PINs. An existing demo database is not
silently cleaned; do not reuse one for production. If reuse is unavoidable,
replace/deactivate every demo identity and rotate all sessions, but a fresh
directory is strongly recommended.

```bash
# This must not print an existing database path for a new deployment.
test ! -e data/rms.db
mkdir -p data backups
# The container runs as the official Node image's non-root user (UID 1000).
sudo chown -R 1000:1000 data backups

docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/setup/status
```

The status should report `"required":true` and `"tokenConfigured":true`.
Production startup fails closed if `RMS_SECRET_KEY` is absent, the development
fallback, or shorter than 32 characters. Inspect logs rather than bypassing that
check:

```bash
docker compose logs --tail=100 rms
```

## 3. Nginx and HTTPS

Replace `rms.example.com` in `deploy/nginx.ec2.conf`, then install both files:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx-connection-map.conf /etc/nginx/conf.d/rms-connection-map.conf
sudo cp deploy/nginx.ec2.conf /etc/nginx/sites-available/rms
sudo ln -s /etc/nginx/sites-available/rms /etc/nginx/sites-enabled/rms
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d rms.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Certbot can create the TLS server and HTTP redirect automatically. The commented
server block in `deploy/nginx.ec2.conf` is an equivalent hardened reference.
Confirm automatic certificate renewal:

```bash
sudo certbot renew --dry-run
curl -I https://rms.example.com/api/session
```

If using a host firewall, allow OpenSSH (restricted), Nginx Full, and deny other
inbound traffic. Port 3000 is bound only to `127.0.0.1` by Compose.

## 4. One-time restaurant setup

1. Open `https://rms.example.com/setup` in a private browser session.
2. Enter the restaurant name, the first General Manager's name, a unique 4- or
   6-digit PIN (prefer 6), and the `RMS_SETUP_TOKEN` from `.env`.
3. Submit once. The server verifies the token, hashes the PIN with scrypt, and in
   one transaction creates only core roles/stations, settings, and that manager.
4. Sign in at `/login` with the new PIN and complete store settings, taxes,
   tables, staff, menu, and routing.

Initialization re-checks that the employee table is empty under an immediate
transaction and cannot be repeated. The token and PIN are not written to audit
values. `/setup` then reports that the workspace is already initialized.

After successful setup, blank `RMS_SETUP_TOKEN` in `.env` and recreate the app:

```bash
# RMS_SETUP_TOKEN=
docker compose up -d --force-recreate rms
curl -fsS http://127.0.0.1:3000/api/setup/status
```

`tokenConfigured` should now be false and `required` should also be false. Keep
`.env` readable only by administrators. Rotating `RMS_SECRET_KEY` invalidates all
existing staff sessions.

## 5. Updates and rollback

Take a backup before every update. Schema migrations run at application startup.

```bash
cd /opt/rms
./scripts/backup.sh
# Fetch/review and check out the intended release commit.
docker compose up -d --build rms
docker compose ps
docker compose logs --tail=100 rms
```

Do not roll back application code without confirming that newer schema migrations
are backward-compatible. Restore the matching database backup when necessary.
Deploy updates during a planned service window; a single container has a short
restart interruption.

## 6. Consistent backups and restore

`scripts/backup-sqlite.ts` uses SQLite's online `VACUUM INTO` snapshot, fsyncs
the completed file, verifies its integrity, applies local retention, and never copies a live
WAL database naively. The wrapper can upload the result to S3 with server-side
encryption using the instance role.

Test it manually, then install the daily cron entry (default 03:17 host time):

```bash
cd /opt/rms
chmod +x scripts/backup.sh
./scripts/backup.sh
ls -lh backups/
sudo cp deploy/rms-backup.cron /etc/cron.d/rms-backup
```

For off-site copies, set `RMS_BACKUP_S3_URI=s3://PRIVATE-BUCKET/rms` in `.env`.
Block public access, enable default encryption, versioning, and a lifecycle rule
on the bucket. Restrict the instance role to the backup prefix. EBS snapshots are
an additional layer, not a replacement for testing application-level restores.

Restore during a service window (use the actual timestamped filename):

```bash
cd /opt/rms
docker compose stop rms
cp -a data/rms.db "data/rms.db.before-restore-$(date +%s)"
rm -f data/rms.db data/rms.db-shm data/rms.db-wal
cp backups/rms-YYYY-MM-DDTHH-MM-SS.db data/rms.db
sudo chown 1000:1000 data/rms.db
chmod 600 data/rms.db
docker compose start rms
curl -fsS http://127.0.0.1:3000/api/session
```

Verify login, current settings, and recent orders. Practice this procedure on a
separate instance before relying on it.

## 7. Production boundaries

- **Payments:** provider SDK configuration and offline approval controls do not
  constitute certified EMV/card settlement. Complete a certified integration,
  provider onboarding, PCI responsibilities, webhook verification, and sandbox
  reconciliation before enabling live cards.
- **Printers and payment terminals:** the hardware check proves TCP reachability
  only. An EC2 server cannot automatically reach restaurant-LAN devices. Use a
  secured site agent/VPN with narrow firewall rules and test actual device
  protocols; do not expose raw printer/terminal ports to the internet.
- **Database:** SQLite permits this single-writer architecture only. Keep one app
  instance, use local durable storage, and migrate to managed PostgreSQL plus
  object storage/external queues before horizontal scaling or multi-region use.
- **Availability:** one EC2 instance is a single point of failure. Use EBS/S3
  backups, monitoring, alarms, and a tested recovery runbook. Managed PostgreSQL
  alone does not remove the need for session/shared-state and migration design.
- **Provider secrets:** non-empty `RMS_*` credential variables in `.env` override
  SQLite values and remain masked in the portal. Rotate them at the provider and
  restart/recreate the container. The current provider test buttons do not
  activate external delivery.

Demo seeding remains available for development. Production seed and destructive
reset commands refuse to run unless their explicit environment override is set;
those overrides should never be present in the normal production environment.
