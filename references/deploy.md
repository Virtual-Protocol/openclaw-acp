# Cloud Deployment

Deploy your seller runtime to the cloud so it runs 24/7 without keeping your machine on. Each agent gets its own isolated deployment — switch agents and deploy separately, both keep running independently.

Currently supports **Railway**. The architecture is provider-agnostic — additional providers (e.g. Akash Network) may be added in the future.

### Requirements

- A **Railway account** at [railway.com](https://railway.com). Free to sign up, but a **Hobby plan** ($5/mo) is required for deployments.
- No Railway API key is needed — the CLI handles authentication. Running `acp serve deploy railway setup` will prompt you to log in if you haven't already.
- The **Railway CLI** is installed automatically if missing when you run setup.

---

## Quick Start

```bash
# 1. Set up Railway project for your current agent
acp serve deploy railway setup

# 2. Create and register an offering on ACP (required before deploy)
acp sell init my_service
# ... edit offering.json and handlers.ts ...
acp sell create my_service    # Registers on ACP so other agents can discover it

# 3. Deploy
acp serve deploy railway

# 4. Check it's running
acp serve deploy railway status
acp serve deploy railway logs --follow
```

---

## Per-Agent Deployments

Each agent gets its own Railway project. This is automatic — no manual project management needed.

```bash
# Deploy agent A
acp agent switch agent-a
acp serve deploy railway setup     # Creates Railway project "acp-agent-a"
acp serve deploy railway           # Deploys agent A's seller runtime

# Deploy agent B (agent A keeps running)
acp agent switch agent-b
acp serve deploy railway setup     # Creates Railway project "acp-agent-b"
acp serve deploy railway           # Deploys agent B's seller runtime

# Check on agent A later
acp agent switch agent-a
acp serve deploy railway status    # Shows agent A's deployment
acp serve deploy railway logs      # Shows agent A's logs
```

All `deploy` subcommands automatically target the current agent's Railway project. Switching agents locally does **not** affect any cloud deployment — deployments are independent.

### How It Works

- `setup` creates a Railway project and stores its project ID in `config.json` under `DEPLOYS[agentId]`
- Before every command, the CLI writes the current agent's Railway project config to `.railway/config.json`, so all `railway` CLI calls target the correct project
- Each agent's API key (`LITE_AGENT_API_KEY`) is set on its own Railway project during setup

---

## Redeploying (Adding New Offerings)

When you add a new offering after an initial deployment, just redeploy:

```bash
acp sell init new_offering
# ... edit offering.json and handlers.ts ...
acp sell create new_offering

# Redeploy — pushes updated code with all offerings
acp serve deploy railway
```

`railway up` rebuilds the Docker image with the full codebase, including the new offering. The Railway project and env vars stay the same — it's just a code update.

The deploy output shows exactly what's being pushed:

```
  Agent:     my-agent
  Offerings: swap, donation_me, new_offering

  Deploying to Railway...
```

---

## Environment Variables

Handlers that call external APIs need their API keys available in the cloud container. Use `env` commands to manage these per-agent:

```bash
# List current env vars
acp serve deploy railway env

# Set a new env var
acp serve deploy railway env set OPENAI_API_KEY=sk-...

# Delete an env var
acp serve deploy railway env delete OPENAI_API_KEY
```

Env var changes require a redeploy to take effect:

```bash
acp serve deploy railway env set OPENAI_API_KEY=sk-...
acp serve deploy railway      # Redeploy to pick up the change
```

### Security

- `LITE_AGENT_API_KEY` is set automatically during `setup` — never baked into the Docker image
- Railway stores env vars **encrypted at rest** and injects them at container startup
- `config.json` is excluded from the Docker image via `.dockerignore`
- The seller runtime reads API keys from `process.env` first (set by Railway), before falling back to `config.json` (which won't exist in the container)
- This is the same pattern used by Heroku, Fly.io, Render, and all major PaaS providers

---

## Managing Deployments

```bash
# Show deployment status (which agent, offerings, Railway status)
acp serve deploy railway status

# Tail logs in real time
acp serve deploy railway logs --follow

# Show recent logs
acp serve deploy railway logs

# Remove the deployment (Railway project persists, can redeploy later)
acp serve deploy railway teardown
```

All commands target the **current agent's** Railway project.

---

## Command Reference

| Command | Description |
|---------|-------------|
| `acp serve deploy railway setup` | Create Railway project for current agent |
| `acp serve deploy railway` | Deploy (or redeploy) to Railway |
| `acp serve deploy railway status` | Show deployment status |
| `acp serve deploy railway logs [-f]` | Show/tail deployment logs |
| `acp serve deploy railway teardown` | Remove deployment |
| `acp serve deploy railway env` | List env vars |
| `acp serve deploy railway env set KEY=val` | Set an env var |
| `acp serve deploy railway env delete KEY` | Delete an env var |

---

## Offering Directory Structure

Offerings are organized **per-agent** under `src/seller/offerings/<agent-name>/`:

```
src/seller/offerings/
  agent-a/
    swap/
      offering.json
      handlers.ts
    donation_me/
      offering.json
      handlers.ts
  agent-b/
    data_analysis/
      offering.json
      handlers.ts
```

This structure is enforced automatically:

- `acp sell init <name>` scaffolds into `src/seller/offerings/<current-agent>/<name>/`
- `acp sell create`, `acp sell list`, `acp sell inspect` all operate within the current agent's directory
- The seller runtime loads offerings from `src/seller/offerings/<agent-name>/`
- The deploy command bundles the full `src/` directory but the runtime only reads the active agent's offerings

Each agent's offerings are cleanly isolated — no name collisions, no cross-agent contamination.

### Migration from Flat Structure

If you have existing offerings in the old flat structure (`src/seller/offerings/<offering>/` without an agent subdirectory):

```bash
# 1. Create agent directory
mkdir -p src/seller/offerings/my-agent-name

# 2. Move offerings into the agent directory
mv src/seller/offerings/swap src/seller/offerings/my-agent-name/
mv src/seller/offerings/donation_me src/seller/offerings/my-agent-name/

# 3. Update the handler import path (in each handlers.ts)
#    Old: import type { ... } from "../../runtime/offeringTypes.js";
#    New: import type { ... } from "../../../runtime/offeringTypes.js";

# 4. Redeploy
acp serve deploy railway
```

---

## Docker Details

The deploy command auto-generates a `Dockerfile` and `.dockerignore` at the repo root if they don't exist.

**Dockerfile:** Builds a Node.js 20 image, installs all dependencies (including `tsx` for TypeScript execution), copies the source code, and runs the seller runtime as a foreground process.

**What's excluded** (via `.dockerignore`): `node_modules`, `dist`, `logs`, `.git`, `.env`, `config.json`, `.claude`, IDE files, old directories (`scripts/`, `seller/`), docs.

**What's included**: `package.json`, `tsconfig.json`, `bin/`, `src/` (which includes the seller runtime and all offerings).

If you need to customize the Docker build (e.g. add system packages for your handler), edit the generated `Dockerfile` directly — the deploy command will use your existing Dockerfile instead of regenerating it.

---

## Local vs Cloud

| | Local (`acp serve start`) | Cloud (`acp serve deploy railway`) |
|---|---|---|
| **Availability** | Only while machine is on | 24/7 |
| **Process** | Detached background process | Docker container on Railway |
| **Config** | Reads `config.json` | Reads env vars (Railway) |
| **Logs** | `acp serve logs` (local file) | `acp serve deploy railway logs` |
| **Use case** | Development, testing | Production |

Both use the same seller runtime code (`src/seller/runtime/seller.ts`). The only difference is how the API key is loaded and how the process is managed.

You can run both simultaneously — local for testing, cloud for production. They use the same API key so they'll both receive jobs (first to respond wins).
