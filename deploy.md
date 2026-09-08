# Deploying Hermes Agent on Coolify

This is step 1 of 3. The other two are `command-center` (Mission Control) and
`agent-control-protocol-adapter`. The order matters only in that the adapter
needs both of the others to exist before it can do anything useful; deploy this
one first.

**No Hermes source file is modified.** This fork adds exactly two files to
upstream — `deploy.md` and `docker-compose.coolify.yml`, both at the repository
root, neither of which is a name upstream uses. Everything Hermes actually runs
is upstream's, unchanged. `PROJECT-STRUCTURE.md` states the guarantee precisely
and gives the one command that verifies it.

**It builds from this repository, at the commit Coolify checked out.** Nothing
floats: no published image, no `:latest`, no git ref resolved at build time.
Coolify clones one commit through the GitHub App and builds upstream's own
`Dockerfile`, and the deployment page records which commit that was.

Files this guide uses:

| File | Role |
|---|---|
| `docker-compose.coolify.yml` | the compose file Coolify deploys (repo root) |
| `Dockerfile` | upstream's, unchanged; the compose file builds it |
| `docker-compose.yml` | upstream's single-host file. **Not** used on Coolify — it uses `network_mode: host` and a `~/.hermes` bind mount, neither of which works there |

---

## What actually gets deployed

Hermes is **two HTTP services**, and everything downstream depends on knowing
that:

| Service | Port | Serves | Credential |
|---|---|---|---|
| Gateway | `8642` | `GET /health`, `/v1/chat/completions`, `/v1/models` | `API_SERVER_KEY` |
| Dashboard | `9119` | the `/api/*` resources, `GET /api/status` | a dashboard access token |

Both run in **one container**. The gateway is the container's main program
(`command: ["gateway", "run"]`); the dashboard is supervised beside it by
s6-overlay when `HERMES_DASHBOARD=1`. They share one `/opt/data` volume, which
is why they cannot be split into two Coolify services — two containers writing
the same Hermes home is not a supported configuration.

Sessions, skills, config, cron and MCP are **all on the dashboard**. A
deployment where only the gateway works gives you chat and nothing else.

The two services do not share a URL namespace. The gateway has no `/api/*`
surface at all — it 404s every one of these routes. Gateway liveness is
`GET /health`; dashboard liveness is `GET /api/status`.

---

## 1. Connect the GitHub App (once per Coolify instance)

Skip this if you already have a sincelabs GitHub App source in Coolify.

1. Coolify → **Sources** → **+ Add** → **GitHub App**.
2. Name it (e.g. `sincelabs`), leave the defaults, **Register Now**. GitHub
   opens; create the app under the `sincelabs` organisation.
3. Back in Coolify, **Install** it and grant access to all three:
   `sincelabs/hermes-agent`, `sincelabs/command-center` and
   `sincelabs/agent-control-protocol-adapter`.

Coolify clones each repository itself through this App, so all three work
whether they are public or private.

The same source is reused by the other resources. Coolify installs a webhook per
resource, so each repo redeploys independently on push.

## 2. Create the resource

1. Coolify → your project → **+ New Resource** → **Private Repository (with
   GitHub App)** → pick the sincelabs source.
2. Repository `sincelabs/hermes-agent`, and whichever branch carries this file.

   > **Check the revision, not the branch name.** Branch names move. Confirm
   > the branch you name has `docker-compose.coolify.yml` at the repository
   > root; Coolify builds from GitHub, so step 4 has nothing to resolve
   > otherwise.

3. **Build Pack: Docker Compose.**
4. **Docker Compose Location:** `/docker-compose.coolify.yml`
5. Save. Do **not** deploy yet — the environment variables come first.

### Enable the shared network

**Configuration → Advanced → Connect To Predefined Network: on.**

This is what puts the container on Coolify's `coolify` network and registers
`hermes-agent` — the compose *service* name — as a network alias. Without it the
adapter cannot resolve this agent at all. The alias is re-applied identically on
every deploy; the container *name* churns (`hermes-agent-<uuid>-<n>`) and must
never be used as a hostname.

## 3. Environment variables

Coolify parses the compose file and creates one editable variable for every
`${VAR}` it finds. Values written literally in the compose file are **not**
editable from the UI — that is deliberate, and is why only the choices below
appear.

Generate the secrets first:

```bash
openssl rand -hex 32   # API_SERVER_KEY
openssl rand -hex 32   # HERMES_DASHBOARD_BASIC_AUTH_SECRET
```

| Variable | Value | Secret? | Notes |
|---|---|---|---|
| `API_SERVER_KEY` | 32-byte hex | yes | The gateway refuses to start its API server without this. The adapter needs the same value as its `HERMES_API_TOKEN` |
| `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` | e.g. `admin` | no | Registers the bundled `basic` auth provider |
| `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` | a strong password | yes | Hashed in memory at startup |
| `HERMES_DASHBOARD_BASIC_AUTH_SECRET` | 32-byte hex | yes | **Do not skip this.** See below |
| `HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS` | `31536000` | no | See below |
| `HERMES_DASHBOARD_PUBLIC_URL` | `https://hermes.example.com` | no | Only if you assign a domain in §4. Leave empty otherwise |

Mark the three secrets as **Is Secret** in Coolify.

**Why the auth variables are not optional here.** The dashboard's auth gate
engages automatically on any non-loopback bind, and the server fails closed when
no auth provider is registered. In a container the bind is always non-loopback,
so a dashboard with no username and password does not come up insecure — it does
not come up at all. `HERMES_DASHBOARD_INSECURE` no longer disables the gate; it
is accepted and ignored, with a warning in the log.

**Why `HERMES_DASHBOARD_BASIC_AUTH_SECRET` matters more than it looks.** It is
the token-signing key. Left unset, the provider generates a random one per
process — so every dashboard token, including the long-lived one the adapter
holds, is invalidated by any restart or redeploy. Set it once and keep it.

**Why the TTL is a year.** `HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS` is the
access-token lifetime and defaults to 12 hours. Browser sessions refresh
transparently, but the adapter holds a bare bearer token and does not refresh
it, so on the default the adapter loses the dashboard overnight and reports
itself degraded until someone mints a new token. A year makes it a machine
credential you rotate deliberately. The trade is real: that token is a
full-access dashboard credential for as long as it lives. Rotate it by changing
this secret, which invalidates every outstanding token at once.

## 4. Domain (optional)

The gateway must stay internal. The dashboard is a normal web UI and you may
want to reach it:

1. **Configuration → hermes-agent → Domains**, set
   `https://hermes.example.com`, port `9119`.
2. Set `HERMES_DASHBOARD_PUBLIC_URL` to that same origin so redirects behind the
   proxy resolve correctly.

Leave both blank to keep Hermes entirely private — the adapter reaches it over
the internal network either way, and you can still reach the dashboard through
Coolify's container terminal or an SSH tunnel to the Coolify host.

Never put a domain on `8642`. The gateway API is a chat-completions endpoint
holding your model credentials; it belongs on the internal network.

## 5. Persistent storage

The compose file declares a named volume `hermes_data` mounted at `/opt/data`,
and Coolify creates and keeps it across deploys. Nothing to configure — but be
aware of what lives there, because losing it is a factory reset:

- sessions and conversation history
- `config.yaml`, provider keys, model configuration
- cron jobs, MCP server definitions, installed skills
- lazily-installed packages under `/opt/data/lazy-packages`

## 6. Deploy and verify

Hit **Deploy**. The first build compiles SQLite and installs a full Python and
Node toolchain — expect it to be slow, and expect the first container start to
be slow too while lazy packages install onto the fresh volume. The healthcheck
allows 180 seconds for that.

From Coolify's terminal on the container:

```bash
# Gateway. Public route, no credential needed.
curl -fsS http://127.0.0.1:8642/health

# Gateway, authenticated.
curl -fsS -H "Authorization: Bearer $API_SERVER_KEY" \
  http://127.0.0.1:8642/v1/models

# Dashboard liveness. Also a public route.
curl -fsS http://127.0.0.1:9119/api/status
```

If `/api/status` does not answer, the dashboard did not start. Search the
container logs for `dashboard-auth-basic:` — a skip reason there means the
username or password is missing and the provider declined to register, which
fails the gate closed.

## 7. Mint the dashboard token for the adapter

The adapter authenticates to `/api/*` with `Authorization: Bearer <token>`. The
gate verifies that against the same provider stack that verifies browser
sessions, so the token you need is the access token the `basic` provider mints
at login. It arrives in a `Set-Cookie` header, not in the response body.

From Coolify's terminal on the **hermes-agent** container:

```bash
curl -sS -D - -o /dev/null \
  -X POST http://127.0.0.1:9119/auth/password-login \
  -H 'content-type: application/json' \
  -d '{"provider":"basic","username":"admin","password":"<the password>"}' \
| grep -i '^set-cookie: hermes_session_at=' \
| sed 's/.*hermes_session_at=\([^;]*\).*/\1/'
```

That value is the adapter's `HERMES_DASHBOARD_TOKEN`. Verify it before going any
further:

```bash
TOKEN=<the value>
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9119/api/skills
```

A 401 here means the token did not verify — most often because
`HERMES_DASHBOARD_BASIC_AUTH_SECRET` was left unset and the container has since
restarted.

The token's lifetime is whatever `HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS` was
at the moment of login. Changing the TTL does not extend a token already minted
— log in again to get one with the new lifetime.

## 8. Profiles

Hermes can host several *profiles*, each with its own home directory, config,
skills and cron jobs. A stock container deployment has exactly one, and you can
ignore this section.

If you run more than one, set the adapter's `HERMES_PROFILE` to the profile it
should manage. The adapter refuses to reconcile cron jobs across an ambiguous
multi-profile install rather than guess, because `GET /api/cron/jobs` aggregates
every profile while writes land in exactly one. See the adapter's `.env.example`.

## 9. What the other two resources need from this one

| They need | It is |
|---|---|
| `HERMES_API_URL` | `http://hermes-agent:8642` |
| `HERMES_DASHBOARD_URL` | `http://hermes-agent:9119` |
| `HERMES_API_TOKEN` | the same value as `API_SERVER_KEY` |
| `HERMES_DASHBOARD_TOKEN` | the token from §7 |

Keep going with `command-center/deploy.md`.

---

## 10. Updating Hermes, and keeping the fork honest

Coolify redeploys this branch on push, so a newer Hermes is a merge away. The
thing worth protecting while you do it is the guarantee that this fork adds
nothing but its two deployment files:

```bash
cd hermes-agent
git fetch upstream
git merge upstream/main            # or rebase, whichever you keep

# The guarantee. Everything except the two deployment files must be
# byte-for-byte upstream, so this must print nothing:
git diff --stat upstream/main HEAD -- .   ':(exclude)deploy.md' ':(exclude)docker-compose.coolify.yml'

git push origin HEAD               # Coolify redeploys
```

If that diff prints a source file, something has been added to the fork that
does not belong here. Move it into the adapter or the server repo — the whole
reason those exist as separate applications is so that this one keeps no logic
of its own.

Neither `deploy.md` nor `docker-compose.coolify.yml` is a filename upstream
uses, so the merge above does not conflict with them.

---

## Troubleshooting

**Build fails on the SQLite or Node stage.** Both fetch tarballs at build time.
A Coolify server behind an egress proxy needs that proxy configured for the
Docker daemon, not just for the shell.

**Container starts, then exits.** Check that nothing overrode the entrypoint.
`/init` must be PID 1 — it runs the cont-init scripts and sets up the
supervision tree. If it is bypassed, the gateway will not work correctly and the
dashboard never starts at all.

**`/api/status` answers but every other `/api/*` route 401s.** Expected. Those
routes are gated. The public allowlist is small — `/api/health`, `/api/status`,
`/api/config/defaults`, `/api/config/schema`, `/api/model/info`, the dashboard
theme and plugin manifests, and the `/api/cron/fire` webhook (which carries its
own JWT). Everything else needs the bearer token from §7.

**The adapter reports the dashboard unavailable after a redeploy.**
`HERMES_DASHBOARD_BASIC_AUTH_SECRET` is unset, so the signing key was
regenerated and the adapter's token no longer verifies. Set it, redeploy, mint a
new token.

**`getent hosts hermes-agent` returns nothing from another container.** The two
resources are not both on the predefined network, or you used the Coolify
container name instead of the compose service name.
