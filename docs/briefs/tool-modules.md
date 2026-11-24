# Brief: per-task isolation, then a modular tool registry for isidore

**Shape:** one implementing agent working in five phases (0–4), then a separate
review agent that gets the diff, not this brief's conclusions. Phase 0 is a
prerequisite: it ships and is reviewed on its own PR before any registry work
starts.

## Goals

1. **Per-task isolation (Phase 0).** A task can read and write **only its own
   task space**: its conversation workspace `/state/workspaces/<root-id>/`
   (cwd, `$HOME`, `TMPDIR`, sessions). It must not be able to touch other
   workspaces, the task store, the shared Pi config, the tool registry,
   secrets, or another task's data through isidore's API. The only exception is
   the read-only access it needs to run.
2. **Tool registry (Phases 1–4).** A task's tool set is composed from a
   registry when its worker spawns. Running tasks, and the agents they spawn,
   can create, register and use new tools from inside the system, without
   rebuilding images.

## Decisions (already made by the owner)

- Promoting a tool to global scope always requires human approval.
- v1 tool kinds: agents can author `mcp` and `command` tools. `extension` tools
  are human-authored only.
- A child task inherits its parent's tools pinned to the version current at
  spawn.

## Current state (read these first)

**Isolation today: none beyond a separate cwd.**

- Every worker runs as the same uid (1000) in the same container as the isidore
  service, with `/state` (bind mount) fully readable and writable. A task can:
  - read and write other tasks' workspaces (`/state/workspaces/*`);
  - read and write the task store (`isidore/src/store.ts`, under `/state`);
  - read and write the shared Pi config `/state/pi`, including `mcp.json`
    (which changes every later task) and `auth.json`;
  - read `/run/secrets/telegram` and `/run/secrets/openrouter`;
  - read `/proc/<isidore-pid>/environ`, which holds `ISIDORE_TOKEN`,
    `ISIDORE_SCHEDULER_TOKEN` and `OPENROUTER_API_KEY`.
- `isidore/src/runner.ts:151-170` gives each task its own `HOME`, `TMPDIR` and
  `PI_CODING_AGENT_SESSION_DIR` and strips `ISIDORE_*`, `SCHEDULER_*` and
  `PI_SANDBOX_*` from its env. **`OPENROUTER_API_KEY` is not stripped.**
- The isidore API (`:8920`, no auth unless `ISIDORE_TOKEN` is set) is reachable
  from workers over `localhost` and `isidore:8920`. A task can list, read,
  cancel and delete every other task. The scheduler MCP's `list_schedules` and
  `cancel_schedule` likewise span all tasks.
- A conversation is a chain of tasks sharing the root task's workspace and Pi
  session (`rootId()` in `store.ts`). The unit of isolation is therefore the
  **conversation**, not the single turn.

**Tools today come from three hard-wired sources:**

1. Built-in Pi extensions. `isidore/src/worker.ts:102-107` passes the codemode,
   tool_search and mcp extensions as `extensionFactories`.
2. Pi packages. `pi-web-access` is baked into `/opt/pi-config` at build time
   and seeded into `/state/pi` by `isidore/entrypoint.sh`.
3. MCP servers. `isidore/entrypoint.sh` writes `browser` and `scheduler` into
   the shared `/state/pi/mcp.json` with `jq`. The scheduler entry sends
   `X-Isidore-Origin: ${ISIDORE_TASK_ORIGIN}`, which Pi expands per worker and
   the scheduler uses for Telegram routing
   (`scheduler/scheduler/server.py:58-67`). **This must keep working.**

"Spawned agents" today means a task calls `schedule_task`, and the scheduler
later calls `POST /api/tasks` with `origin` and `schedule_id`. That request
carries no parent task id.

## Verified platform facts

- **Landlock ABI 4 is available inside the existing hardening.** This was
  probed in a container started with `--read-only --cap-drop ALL
  --security-opt no-new-privileges:true --user 1000:1000` and Docker's default
  seccomp profile: `landlock_create_ruleset(NULL, 0, VERSION)` returned 4. The
  host LSM list includes `landlock`. ABI 4 provides:
  - filesystem access rights;
  - TCP `bind`/`connect` port rules;
  - ptrace scoping, so a sandboxed process cannot read `/proc/<pid>/environ`
    or `/proc/<pid>/mem` of processes outside its domain.

  ABI 4 does **not** scope signals or abstract unix sockets (that came in
  ABI 6).
- `no-new-privileges` is already set, which satisfies Landlock's
  `no_new_privs` requirement. **No compose privilege changes are needed.**
- Pi SDK, from the installed package:
  - `DefaultResourceLoaderOptions` accepts `extensionFactories`,
    `additionalExtensionPaths`, `disabledBuiltinExtensions` and
    `extensionsOverride`.
  - `pi.registerTool()` works after startup, and the new tool is live in the
    same session (`docs/extensions.md` §registerTool).
  - `refreshTools`, `setActiveTools` and the `mcp_servers_change` event exist.
  - Re-check all of these against the version pinned in `package-lock.json`
    (the image builds the Pi SDK from that lockfile).

## Phase 0: per-task isolation

### Filesystem: Landlock launcher

- Add a small in-repo launcher, `isidore/sandbox/` (C or Rust, about 100 lines,
  built in a multi-stage `Dockerfile` step). It:
  1. takes allow-lists from argv;
  2. applies a Landlock ruleset with `landlock_restrict_self`;
  3. `exec`s the worker.

  Prefer this over a third-party binary because it is small and auditable.
- Change `Runner` (`runner.ts`) to spawn `sandbox <rules> -- node worker.js`
  instead of `node worker.js` directly. The ruleset is inherited by everything
  the agent runs: bash, git, `command` tools and their children.
- The ruleset (deny everything not listed):

  | Path | Access |
  |---|---|
  | `/state/workspaces/<root-id>/` | read + write + exec |
  | `/tmp/isidore-<task-id>/` (if a tmpfs scratch is wanted) | read + write |
  | `/usr`, `/lib*`, `/bin`, `/sbin`, `/etc`, `/opt/isidore`, node and npm global dirs | read + exec |
  | Pi agent dir (see below) | read only |
  | `/dev/null`, `/dev/urandom`, `/dev/tty`, `/proc/self` (via `/proc`) | as needed |
  | `/state` (everything else), `/run/secrets`, `/state/pi` writes, other workspaces | **denied** |

- **Fail closed.** If Landlock is unavailable or the ruleset fails to apply,
  the launcher exits non-zero and the task fails with a clear error.
  `ISIDORE_UNSAFE_NO_SANDBOX=1` is the only override, and it is logged loudly
  at startup.

### Pi agent dir

- The shared `/state/pi` becomes **read-only** for workers. Find what Pi writes
  at runtime (for example `web-search-cache`, settings, update checks): run a
  worker under the launcher in deny-by-default mode and read the `EACCES`
  failures, or use `strace -f -e trace=%file`.
- Redirect each such path into the task's workspace, using env or settings
  where Pi supports it. Otherwise, give each task a small per-task agent dir
  (`<workspace>/.pi/`) that symlinks the read-only parts (`npm/`, `models.json`)
  and holds the writable ones.
- `auth.json` should not be readable by tasks if the key comes from the env.
  Verify that `ModelRuntime` works without it, or create an empty per-task
  copy.

### Secrets and process boundary

- Landlock denies `/run/secrets/*`. Its ptrace scoping blocks reading
  isidore's `/proc/<pid>/environ` and `mem`. **Test both explicitly.** Signals
  are not scoped at ABI 4: a task can still `kill` same-uid processes. Note
  this as a residual risk; mitigating it needs ABI 6 or a separate uid.
- `OPENROUTER_API_KEY` stays in the worker env, because the SDK needs it. It is
  stripped from the env of every subprocess the worker starts: bash, `command`
  tools, git. Check whether Pi's bash tool accepts an env override; if not, wrap
  it.
  - Optional hardening (ABI 4 TCP rules, below): the worker could instead
    reach OpenRouter through a tiny isidore-side proxy that adds the key. That
    is a follow-up, not v1.

### Network: scope isidore's own API

The workspace sandbox is meaningless if a task can still read every task over
HTTP. Two changes:

1. **Per-task capability tokens.** The runner mints a random token per task.
   It stores only a hash, bound to `{task_id, root_id, origin}`, and passes the
   token to the worker in an env var such as `ISIDORE_TASK_TOKEN`. That var is
   exempt from the prefix scrub and is stripped from subprocesses. The `tools`
   MCP (Phase 3) and the scheduler MCP send it as a header.
2. **Scope every API surface reachable from a worker by that token.**
   - The isidore API requires either the admin `ISIDORE_TOKEN` or a task
     token. A task token can only see and act on its own conversation.
   - If `ISIDORE_TOKEN` is unset, isidore generates one at startup and keeps
     it out of worker envs. The UI keeps working: the loopback UI receives it
     from the server, and the README must say exactly how.
   - The scheduler MCP: `list_schedules` and `cancel_schedule` return or act
     only on schedules created by the caller's conversation lineage. This
     needs the conversation id stored on each schedule, which Phase 3 adds
     anyway.
   - Optionally, use the Landlock ABI 4 `connect` rule to restrict TCP to
     `443` (OpenRouter and the web), the browser MCP and scheduler ports, and
     isidore's port.

### Phase 0 acceptance tests

Run all of these from inside a task, both as `bash` tool calls and as a test
that spawns the sandboxed worker with a scripted prompt or a direct launcher
test:

- Reading or writing `/state/workspaces/<other-id>/…` fails with `EACCES`.
  Writing inside its own workspace succeeds. A follow-up turn in the same
  conversation still sees earlier files.
- Reading the task store files under `/state`, `/run/secrets/telegram` and
  `/run/secrets/openrouter` fails.
- Writing `/state/pi/mcp.json` (or any file under `/state/pi`) fails. Reading
  what Pi needs still works, and normal tasks (browser, scheduler,
  pi-web-access search) behave as before.
- `cat /proc/<isidore-pid>/environ` fails.
- `env` in a bash tool call shows no `OPENROUTER_API_KEY`, `ISIDORE_*` or
  `SCHEDULER_*`.
- Without a token, `curl isidore:8920/api/tasks` returns 401. With the task's
  own token, only its conversation is visible. `DELETE` or cancel on another
  task returns 403 or 404.
- `list_schedules` from task B does not show task A's schedules.
- If Landlock is disabled (simulate with a launcher flag in tests), the task
  fails rather than running unsandboxed.
- `npm test` and the scheduler `pytest` suite pass. Add launcher tests next to
  `isidore/test/runner.test.ts`.

## Phases 1–4: tool registry

### Registry

- Owned by the isidore service, stored under `/state/tools/`. Workers have no
  access to it at all: after Phase 0, Landlock enforces this.
- Each tool is `<id>/<version>/manifest.json` plus source files.
- Manifest fields:
  - `id`, `name`, `version`, `kind`, `description`;
  - input JSON Schema;
  - `scope`: `task`, `conversation` (default) or `global`;
  - `status`: `active`, `disabled` or `pending_approval`;
  - `provenance`: creator task id, root id, origin, timestamp, sha256.
- Versions are immutable, so a tool can be rolled back.

### Tool kinds (v1)

| Kind | Runs where | Authored by |
|---|---|---|
| `mcp`: URL plus headers to an MCP server (`${VAR}` header templating preserved) | remote | agents or humans |
| `command`: script plus argv template plus input schema; stdout becomes the result | subprocess of the worker, **inside the same Landlock domain**, cwd = workspace, scrubbed env | agents or humans |
| `extension`: Pi extension module | in-process in the worker | humans only |

- `browser` and `scheduler` become builtin `mcp` manifests generated from
  `PI_SANDBOX_*_URL`.
- codemode, tool_search and mcp become builtin `extension` entries.
- The `jq` block in `entrypoint.sh` is deleted.

### Composition at spawn

- The runner resolves the task's tool set: global tools, plus tools scoped to
  its conversation, plus tools scoped to the task.
- It **copies** the code of `command` tools into a read-only directory the
  task can read, for example `/state/tool-cache/<root-id>/`, which is added to
  the Landlock read list.
- It passes the resolved manifests in the `WorkerRequest`.
- The worker loads one inline **registry extension**. That extension registers
  `command` tools through `pi.registerTool()` and adds `mcp` servers
  per-worker. There is no shared `mcp.json` any more.

### Agent authoring surface

A `tools` MCP server hosted by isidore and authenticated by the task token.
Its operations are scoped to the caller's conversation:

- `tool_create(name, kind, description, input_schema, files|url, scope?)`:
  validates and stores the tool. **It is live in the same turn:** the registry
  extension is notified and calls `registerTool`.
- `tool_list`, `tool_get`, `tool_update` (creates a new version),
  `tool_disable` and `tool_remove`.
- `tool_request_promotion(id, reason)`: sets the tool to `pending_approval`.

Agents can create `mcp` and `command` tools only.

### Spawned agents and lineage

- `POST /api/tasks` takes `parent_task_id`, which is derived from the task
  token and never trusted from the request body.
- The scheduler stores the conversation id on each schedule
  (`scheduler/scheduler/core.py`) and passes it back when the schedule fires.
  This is the same field Phase 0 uses to scope `list_schedules`.
- A child task gets its **own workspace** (Phase 0 isolation applies). It
  inherits the parent conversation's tools by reference, pinned to the version
  current at spawn.
- Tools the child creates stay in the child's conversation unless promoted.

### Human surface

- Web UI tools panel and `/api/tools` (admin token only):
  - list tools with scope, status, provenance and version;
  - approve or reject promotions;
  - disable and roll back.
- Telegram (optional): `/tools` lists tools and `/approve <id>` approves one.
- Deleting a conversation deletes its scoped tools and their tool cache.

### Limits

- Maximum tools per conversation.
- Maximum manifest and source size.
- Per-call timeout for `command` tools.
- Output truncation (reuse `MAX_EVENT_TEXT`).

### Registry acceptance tests

- Task A creates a `command` tool and **uses it in the same turn**. A follow-up
  in A's thread still sees it.
- An unrelated conversation can neither see nor call A's tool, and cannot read
  its source on disk.
- A's tool runs sandboxed: it cannot read outside A's workspace, and its env
  has no `OPENROUTER_API_KEY`.
- A schedule from A fires a child task that sees A's tool (pinned version) in
  its own workspace. A tool the child creates is invisible to A unless it is
  promoted.
- After human approval, a new task sees the promoted tool. After
  `tool_disable`, no new task sees it.
- Browser, scheduler and Telegram reply routing (`X-Isidore-Origin`) work as
  before.

## Phases

0. **Isolation.** Landlock launcher, read-only Pi dir, task tokens, scoped API
   and scheduler. *Own PR; must pass the Phase 0 tests before Phase 1 starts.*
1. **Registry and builtins.** Manifest schema, store and tests. Convert the
   current tools to builtin manifests and remove the `jq` block. *Done when:*
   behavior is identical.
2. **Composition.** Runner resolution, tool cache, `WorkerRequest`, registry
   extension, per-worker MCP config.
3. **Authoring.** `tools` MCP, same-turn registration, lineage through the
   scheduler.
4. **Human surface.** UI panel, `/api/tools`, promotion flow, optional
   Telegram commands, both READMEs.

## Constraints

- Keep the existing style: TypeScript with `--experimental-strip-types`, no new
  runtime npm dependencies unless justified.
- Do not weaken the compose hardening. No added capabilities, no `seccomp:
  unconfined`, no docker socket.
- Don't change the JSONL event stream contract between the worker and the
  server.
- Work on a branch with one PR per phase, at minimum Phase 0 separate. The
  review agent checks every threat-model claim against a test.

## Residual risks to state in the PR

- All tasks share one uid, and Landlock ABI 4 does not scope signals, so a task
  could `kill` another worker. Fixing this needs ABI 6 or per-task uids, which
  require `CAP_SETUID` and so conflict with the current hardening.
- CPU, memory and pids are limited per container, not per task, so a task can
  starve its siblings.
- Outbound network is open apart from the optional port rules. A task can
  exfiltrate anything it can read, which after Phase 0 is only its own
  workspace.

## If run as a team (by file ownership)

- **A: isolation runtime.** `sandbox/`, `runner.ts`, `worker.ts`, `Dockerfile`,
  `entrypoint.sh`.
- **B: auth and API.** Task tokens, `server.ts`, `store.ts`, the `tools` MCP,
  `/api/tools`.
- **C: lineage and UI.** `scheduler/`, `templates/`, `telegram.ts`.
- A and B agree the task-token contract and the `WorkerRequest` shape first.
  C starts once Phase 0 is merged.
