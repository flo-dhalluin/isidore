# Phase 0 acceptance runbook (manual)

Maps each Phase-0 acceptance bullet from `docs/briefs/tool-modules.md` to a
concrete task prompt or `curl`. Run the filesystem/env/proc checks **from inside
a task** (bash tool calls); the API/scheduler checks can be run from inside a
task or from an operator shell.

> **Auth note.** A task's capability token (`ISIDORE_TASK_TOKEN`) lives in the
> *worker* process env (Pi expands it into the scheduler MCP headers) but is
> **scrubbed from every bash child** (`env-scrub.ts`). So a bash `curl` cannot
> read the token from its own environment — the runbook passes it explicitly.
> The admin token is retrieved out-of-band (never injected into the loopback UI,
> because workers share isidore's network namespace).

The filesystem//proc checks require Worker A's Landlock launcher; the
auth/API/scheduler-scoping checks (Worker B) work as soon as B lands.

## Setup

```sh
docker compose up -d --build
ADMIN=$(docker compose exec -T isidore cat /state/shared/admin-token)
# UI: http://127.0.0.1:8920/?token=$ADMIN

# Two conversations, A and B (admin creates both):
A=$(curl -s -X POST localhost:8920/api/tasks -H "Authorization: Bearer $ADMIN" \
      -H 'content-type: application/json' -d '{"prompt":"conversation A"}' | jq -r .id)
B=$(curl -s -X POST localhost:8920/api/tasks -H "Authorization: Bearer $ADMIN" \
      -H 'content-type: application/json' -d '{"prompt":"conversation B"}' | jq -r .id)
```

### Obtaining a task token for the API checks

Task tokens are minted at spawn, held only as a hash in memory, and never
persisted. To exercise the task-token API paths, read the live token from the
worker's environ in an **unsandboxed operator shell** (`docker compose exec` is
not Landlock-confined, so the narrow /proc allow-list does not apply to it):

```sh
docker compose exec isidore sh -c '
  pid=$(ps -eo pid,args | grep "[w]orker.js" | head -1 | awk "{print \$1}")
  tr "\0" "\n" < /proc/$pid/environ | grep ^ISIDORE_TASK_TOKEN=
'
# => ISIDORE_TASK_TOKEN=<64 hex>   (use this literal as TOKEN below)
```

Alternatively paste that token literal into a task prompt so the agent's bash
`curl` uses it explicitly.

## 1. Workspace isolation (EACCES outside, writes inside, follow-up persists)

Task prompt (conversation A):

```
Run these bash commands and report each result:
  echo hi > own.txt && cat own.txt
  ls /state/workspaces/<B-root-id>/
  cat /state/workspaces/<B-root-id>/own.txt
  echo x >> /state/workspaces/<B-root-id>/own.txt
```

Expected: `own.txt` write/read succeeds; every access to B's workspace fails
with `EACCES` (permission denied). Then send a **follow-up** to A ("cat own.txt")
and confirm the earlier file is still there (same workspace + Pi session).

## 2. Task store and secrets are unreadable

Task prompt:

```
Run and report:
  cat /state/tasks/<A-id>.json
  ls /state/tasks
  cat /run/secrets/openrouter
  cat /run/secrets/telegram
```

Expected: all fail with `EACCES`. (The store and secrets are outside the
allow-list; `/run/secrets` has no rule at all.)

## 3. Shared Pi config is read-only; normal tools still work

Task prompt:

```
Run and report:
  echo x >> /state/pi/mcp.json
  cat /state/pi/models.json
Then use the browser tool to open https://example.com and the scheduler tool
list_schedules, and run a pi-web-access search.
```

Expected: the write to `/state/pi/mcp.json` (and any `/state/pi` write) fails
with `EACCES`; reads of `models.json`/`mcp.json` succeed; browser, scheduler and
pi-web-access behave as before. (Per-task `.pi/` copies the small writable
config and symlinks the read-only parts.)

## 4. isidore's process environ is unreadable (narrow /proc allow-list)

Task prompt:

```
Run and report:
  cat /proc/1/environ
  cat /proc/<isidore-pid>/environ
  cat /proc/self/cmdline
```

Expected: reading another pid's `environ`/`mem` fails with `EACCES`;
`/proc/self/cmdline` works. Find `<isidore-pid>` with `ps -eo pid,args`.

Mechanism: Landlock has **no ptrace scope** (the kernel only scopes abstract
unix sockets and signals). Cross-pid `environ`/`mem` reads are denied because
the launcher uses a **narrow /proc allow-list**: only `/proc/self` (resolved to
the worker's pid dir before exec) plus global, non-sensitive proc files
(`meminfo`, `cpuinfo`, `stat`, …) are readable — `/proc/<other-pid>/` has no
rule at all. See the `buildSandboxArgs` comment in `isidore/src/runner.ts`.

## 5. bash env carries no secrets — and neither does the worker's exec env

Task prompt: `Run env and report whether any of these appear:
OPENROUTER_API_KEY, ISIDORE_*, SCHEDULER_*, PI_SANDBOX_*.`

Expected: none appear (bash children are scrubbed). `PATH`, `HOME`, `GIT_*`
remain. `OPENROUTER_API_KEY` is absent **even from the worker's own exec env**:
the runner never passes it through `spawn` — it travels in the stdin JSON
request (`WorkerRequest.apiKey`) and is captured into the ModelRuntime
in-memory. So it is also absent from the worker's `/proc/self/environ` (which
reflects the EXEC-time env; deleting a var from `process.env` later does not
rewrite it). Verify from an unsandboxed operator shell while a task runs:

```sh
docker compose exec isidore sh -c '
  pid=$(ps -eo pid,args | grep "[w]orker.js" | head -1 | awk "{print \$1}")
  tr "\0" "\n" < /proc/$pid/environ | grep -c ^OPENROUTER_API_KEY=   # => 0
'
```

(In-worker check: ask the agent to use the **read tool** on `/proc/self/environ`
— the read tool runs in the worker process, whose `/proc/self` is allowed.
Bash children have different pids, so their `/proc/self` falls outside the
allow-list — a documented residual.)

`ISIDORE_TASK_TOKEN`/`ISIDORE_TASK_ORIGIN` stay in the worker env (Pi expands
them into the scheduler MCP headers) but never in bash children.

## 6. isidore API is token-scoped

From an operator shell (or a task prompt with the token literal pasted in):

```sh
# No token => 401
curl -s -o /dev/null -w '%{http_code}\n' isidore:8920/api/tasks          # 401

# Task A's token => only conversation A
TOKEN=<A's ISIDORE_TASK_TOKEN>
curl -s isidore:8920/api/tasks -H "Authorization: Bearer $TOKEN" | jq '.[].id'   # [A...]
curl -s isidore:8920/api/auth/whoami -H "Authorization: Bearer $TOKEN"           # {task_id,root_id,origin}

# Cross-conversation actions => 404
curl -s -o /dev/null -w '%{http_code}\n' isidore:8920/api/tasks/$B -H "Authorization: Bearer $TOKEN"        # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST isidore:8920/api/tasks/$B/cancel -H "Authorization: Bearer $TOKEN"  # 404
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE isidore:8920/api/tasks/$B -H "Authorization: Bearer $TOKEN"       # 404

# ?token= is admin-only: a task token in the query is refused
curl -s -o /dev/null -w '%{http_code}\n' "isidore:8920/api/tasks?token=$TOKEN"   # 401
```

Expected: 401 without/with invalid token; A's token sees only A; cross-conversation
get/thread/cancel/delete/followup are 404; `?token=` accepts only the admin token.

## 7. Scheduler MCP is conversation-scoped

From conversation B's task prompt: `Use the scheduler tool list_schedules.`
Expected: B does **not** see schedules created by A. Have A call
`schedule_task(prompt="A job", every="1h")`, then B calls `list_schedules` (empty
of A's job) and `cancel_schedule(<A's schedule id>)` (tool error). An admin
`Authorization: Bearer $SCHEDULER_TOKEN` on `/mcp` still sees everything.

REST proxy equivalent (operator shell): isidore sends
`X-Isidore-Conversation-Id` alongside the admin Bearer for task-token callers;
`GET /api/schedules` on the scheduler filters to that conversation, and a plain
admin request sees all.

The scheduler REST API is **never unauthenticated** (even when `SCHEDULER_TOKEN`
was unset — it generates one at startup and publishes it to the `scheduler-auth`
volume, which isidore reads). From a task's bash (no token in its env):

```sh
curl -s -o /dev/null -w '%{http_code}\n' scheduler:8940/api/schedules   # 401
```

The generated scheduler token never reaches workers: it is not in `mcp.json`,
the runner scrubs `SCHEDULER_*`/`ISIDORE_*` from the worker env, and
`/state/scheduler-shared/scheduler-token` is outside the Landlock allow-list
(`cat` from a task fails with `EACCES`).

## 8. Fail closed when Landlock is unavailable

Covered by the automated launcher tests (`isidore/test/sandbox.test.ts`,
`--min-abi 99` simulates an unavailable ABI): the launcher exits non-zero,
prints `isidore-sandbox: <reason>` to stderr, never execs, and the task is marked
failed. In production a missing `ISIDORE_SANDBOX_BIN` likewise fails the task;
`ISIDORE_UNSAFE_NO_SANDBOX=1` is the only override and is logged loudly.

## 9. Automated suites

```sh
cd isidore && npm test          # store/runner/server/tokens/env-scrub (+ sandbox after A)
cd scheduler && uv run python -m unittest discover tests   # core + scoping + lineage
```

Both must pass. Launcher tests live next to `isidore/test/runner.test.ts`.

## 10. Phase 3 acceptance (authoring, same-turn, lineage)

Automated coverage (all in the suites above):

- **Same-turn create/use** — `test/tools-mcp.test.ts` "real Pi MCP client":
  a real `AgentSession` with `createMcpExtension` connects to the live
  `/mcp/tools` endpoint; `tool_create` driven through `ctx.executeTool` (the
  nested codemode path) registers the command tool via the `tool_result` hook
  BEFORE the creating call resolves, and the tool executes. Hook mechanics
  (wrapped/direct/JSON-text payloads, duplicate guard, disable stub, mcp
  unregister) are in `test/registry-extension.test.ts`.
- **Follow-up sees it / B cannot** — `tools-mcp.test.ts` scoping tests
  (list/get/update/disable/remove/promotion across conversations) and
  `tools.test.ts` `resolveFor` unions; B's cache dir never holds A's sources.
- **Sandboxed execution** — Phase 2 `sandbox.test.ts` (tool-cache `--rx`,
  `/state/tools` denied) + `registry-extension.test.ts` (scrubbed env,
  workspace cwd) apply unchanged to authored command tools.
- **Child lineage** — `server.test.ts` "admin POST conversation_id pins
  inherited_tools…": the child is a NEW root with its own workspace, the
  worker request carries the pinned version with a cache copy under the
  child's root; task-token POST ignores body `conversation_id`.
  `scheduler/tests/test_lineage.py`: fire carries `conversation_id`, the
  client forwards it only when truthy, legacy schedules fire unchanged.
- **Child tools invisible to the parent** — `tools-mcp.test.ts` "child
  authoring scope": ownership follows the child's token; promotion is a
  REQUEST (pending_approval + reason on the index) and only a human approval
  (Phase 4) makes it global.
- **Promotion / disable** — `tools-mcp.test.ts` promotion + disable/remove
  tests; pending/disabled tools never resolve for new spawns.
- **Pending-global isolation (review fix)** — `tools-mcp.test.ts` "pending
  globals: invisible to other conversations…" + "quota counts pending
  globals": a pending global KEEPS creator ownership (owner_root_id/
  owner_task_id on the index) until human approval clears it (Phase 4
  `registry.clearOwnership`). Other conversations can neither list/get it
  (no source leak) nor are blocked by its names; the creator can still
  update/disable/remove it; it counts against the 32-tool quota. Active
  globals stay visible to everyone.
- **MCP namespace clashes (review fix)** — `tools.test.ts` "MCP namespace
  collisions": names differing only in `-`/`_` are rejected at authoring
  (pi's `mcpNamespace` maps `-` to `_`); `registry-extension.test.ts`
  "spawn-time registration failure…" proves one failing registration no
  longer drops the whole tool set (fake pi + real session).
- **Delete cascade / update scope (review fixes)** — `server.test.ts`
  cascade test: deleting a conversation also sweeps children's pinned cache
  copies of its tools across ALL roots; `tools-mcp.test.ts`: `tool_update`
  rejects `scope` (create-only), extension kind is rejected for ALL callers
  (human-authored via the admin API, Phase 4), and disabled/pending tools
  are not cache-staged on update.

Manual same-turn smoke (sandbox on, after `docker compose up -d --build`):

```
Conversation A prompt:
  Use the tools MCP tool_create to make a command tool named greeter
  (argv ["echo", "hello {{name}}"], schema {name: string}), then call
  greeter with name="world" in this same turn and report its output.
```

Expected: the create result carries `{manifest, cachePath}`; `greeter` is
callable in the SAME turn (no follow-up needed) and prints `hello world`.
A follow-up ("call greeter again") still sees it; conversation B's
`tool_list` does not. Then have A `schedule_task(prompt="call greeter",
at="+1m")`: the fired child runs in its OWN workspace with the pinned
tool, and a tool the child creates is absent from A's `tool_list`.

## 11. Files (`send_file`)

Automated: `test/files-mcp.test.ts` (protocol, copy, download, conversation
scoping, workspace confinement, oversized files, delete cascade).

Manual smoke:

```
Conversation A prompt:
  Write a short report to report.md, then call send_file for it.
```

Expected: the turn in the task view shows a `report.md` download link; the
admin token fetches the bytes from
`GET /api/tasks/<A-id>/artifacts/<artifactId>`. Conversation B's task token
gets 404 for that artifact. `send_file(path="/state/shared/admin-token")` is
refused (outside the workspace).

