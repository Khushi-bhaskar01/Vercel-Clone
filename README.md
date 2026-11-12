# DeployForge

A mini Vercel: paste a GitHub repo URL, and it gets cloned, built in an isolated container on AWS ECS, uploaded to S3, and served at its own subdomain — with build logs streamed live to the browser.

```
http://<project-slug>.localhost:8000  →  your deployed site
```

---

## Architecture

```
                         ┌──────────────────────────┐
   User (browser)        │  Frontend (React + Vite) │  :5173
        │                │  enter repo URL + slug   │
        │                └────┬──────────────▲──────┘
        │        POST /project│              │ live logs (socket.io)
        │                     ▼              │
        │           ┌─────────────────────────────────┐
        │           │  api-server (Express)    :9000  │
        │           │  socket.io server        :9002  │
        │           └──┬──────────────────────▲───────┘
        │              │ RunTask (Fargate)     │ PSUBSCRIBE logs:*
        │              ▼                       │
        │   ┌──────────────────────────┐   ┌───┴──────────────────┐
        │   │ AWS ECS: build-server    │──▶│ Redis / Valkey       │
        │   │ (Docker container)       │pub│ channel logs:<slug>  │
        │   │ main.sh: git clone repo  │   └──────────────────────┘
        │   │ script.js: npm install,  │
        │   │   npm run build,         │
        │   │   upload dist/ ──────────┼──▶ S3 bucket
        │   └──────────────────────────┘    __outputs/<slug>/...
        │                                        ▲
        │  http://<slug>.localhost:8000          │ proxies request
        └──────────▶ ┌─────────────────────────┐ │
                     │ s3-reverse-proxy  :8000 │─┘
                     │ subdomain → S3 folder   │
                     │ "/" → index.html        │
                     └─────────────────────────┘
```

### Services

| Folder | What it does | Port |
|---|---|---|
| `frontend/vercel-clone-frontend` | React + Vite + Tailwind UI. Submits the repo URL and shows live build logs. | 5173 |
| `api-server` | Express API. `POST /project` launches a Fargate build task on ECS. Also runs a socket.io server that relays build logs from Redis to the browser. | 9000 (HTTP), 9002 (socket.io) |
| `build-server` | Docker image run as an ECS task. Clones the repo, runs `npm install && npm run build`, uploads `dist/` to S3, and publishes every log line to Redis. | — |
| `s3-reverse-proxy` | Reads the subdomain from the request and proxies it to `S3/__outputs/<subdomain>/`. Rewrites `/` to `/index.html`. | 8000 |

### Deploy flow

1. **Submit:** the user enters a GitHub URL (and an optional slug) in the frontend.
2. **Queue:** the frontend calls `POST /project`. The api-server generates a slug (random if none was given) and calls ECS `RunTask`. It passes `GIT_REPOSITORY__URL` and `PROJECT_ID` to the container as environment overrides.
3. **Subscribe:** the frontend joins the socket.io room `logs:<slug>`.
4. **Build:** the container clones the repo into `/home/app/output`, installs, builds, and uploads every file in `output/dist` to `s3://<bucket>/__outputs/<slug>/` with the correct `Content-Type`.
5. **Stream logs:** each log line is `PUBLISH`ed to the Redis channel `logs:<slug>`. The api-server `PSUBSCRIBE`s to `logs:*` and forwards each message to that socket.io room.
6. **Serve:** visiting `http://<slug>.localhost:8000` hits the reverse proxy, which streams the files straight from S3.

> The build server expects a project whose build output goes to `dist/`, e.g. a Vite app.

---

## Tech stack

- **Frontend:** React 18, Vite 5, Tailwind CSS v4, axios, socket.io-client
- **Backend:** Node.js, Express 5, socket.io, ioredis
- **Infra:** AWS ECS (Fargate) + ECR, S3, Redis/Valkey (Aiven)

---

## Environment variables

All services read **one shared `.env` at the project root**. It is git-ignored.

```bash
cp .env.example .env   # then fill in your values
```

| Variable | Used by | Description |
|---|---|---|
| `AWS_REGION` | all backend | e.g. `ap-south-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | api-server, build-server (local) | IAM keys. On ECS, leave these out and use a task role instead. |
| `S3_BUCKET` | build-server, s3-reverse-proxy | Bucket where builds are uploaded |
| `ECS_CLUSTER_ARN` | api-server | ECS cluster that runs builds |
| `ECS_TASK_ARN` | api-server | Task definition for the build-server image |
| `ECS_SUBNETS` | api-server | Comma-separated subnet IDs |
| `ECS_SECURITY_GROUPS` | api-server | Comma-separated security group IDs |
| `ECS_CONTAINER_NAME` | api-server | Container name inside the task definition (default `image-builder`) |
| `REDIS_URL` | api-server, build-server | `rediss://user:pass@host:port` |
| `API_PORT` | api-server | Default `9000` |
| `SOCKET_PORT` | api-server | Default `9002` |
| `FRONTEND_URL` | api-server | Allowed CORS origin, default `http://localhost:5173` |
| `PROXY_PORT` | s3-reverse-proxy | Default `8000` |
| `PROXY_DOMAIN` | api-server | Domain used to build preview URLs, default `localhost:8000` |
| `VITE_API_URL` | frontend | api-server URL |
| `VITE_SOCKET_URL` | frontend | socket.io server URL |

> Only `VITE_*` variables are exposed to the browser. Never put secrets in them.

---

## AWS setup (one-time)

1. **S3:** create a bucket (e.g. `clone-project-vercel`) and allow public `GetObject` on `__outputs/*`, so the proxy can read the files.
2. **ECR:** create a repository, then build and push the build-server image:
   ```bash
   cd build-server
   aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
   docker build -t builder-image .
   docker tag builder-image:latest <ecr-repo-uri>:latest
   docker push <ecr-repo-uri>:latest
   ```
3. **IAM task role:** create a role for *Elastic Container Service Task* that allows `s3:PutObject` on `arn:aws:s3:::<bucket>/*`.
4. **ECS:**
   - Create a Fargate cluster.
   - Create a task definition that uses the ECR image, with a container named `image-builder`.
   - Attach the task role from step 3.
   - Add these container environment variables: `REDIS_URL`, `S3_BUCKET`, `AWS_REGION`.
5. **Network:** the subnets and security group must allow outbound internet access, which the container needs for GitHub, npm, S3 and Redis.
6. Copy the cluster ARN, task ARN, subnets and security groups into `.env`.

---

## Running locally

```bash
# 1. Install dependencies
cd api-server && npm install && cd ..
cd s3-reverse-proxy && npm install && cd ..
cd frontend/vercel-clone-frontend && npm install && cd ../..

# 2. Start each service (separate terminals)
node api-server/index.js          # :9000 + socket :9002
node s3-reverse-proxy/index.js    # :8000
cd frontend/vercel-clone-frontend && npm run dev   # :5173
```

Open http://localhost:5173, paste a GitHub repo URL (e.g. a Vite React app), and click **Deploy**. Watch the logs. When you see `Done...`, open the preview URL.

> `*.localhost` subdomains resolve to 127.0.0.1 in modern browsers, so no hosts-file edits are needed.

---

## Project structure

```
Vercel Clone/
├── .env.example                 # template for the shared .env
├── api-server/
│   └── index.js                 # REST API + socket.io + ECS launcher
├── build-server/
│   ├── Dockerfile               # Ubuntu + Node 20 + git
│   ├── main.sh                  # clones the repo, then runs script.js
│   └── script.js                # build → upload to S3 → publish logs
├── s3-reverse-proxy/
│   └── index.js                 # subdomain → S3 proxy
└── frontend/vercel-clone-frontend/
    └── src/App.jsx              # deploy form + live log viewer
```

---

## Known limitations / ideas

- No database: projects and deployments aren't stored anywhere.
- Only `dist/` output is supported.
- No auth or rate limiting on `POST /project`.
- The build container runs `npm install` on untrusted repos. That's OK in isolated Fargate tasks, but don't run it on your own machine.
- Possible next steps: Postgres for projects/deployments, logs stored in ClickHouse, custom domains, GitHub OAuth.
