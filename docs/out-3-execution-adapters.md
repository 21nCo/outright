# OUT-3 execution adapter contract

The scheduler in `server/agent-manager.mjs` owns supervision, persistence, recovery and capacity. Everything provider-specific lives in an adapter under `server/execution-adapters/`, and the registry in `index.mjs` is the only list of providers. Persisted conversations and runs store the adapter id, so ids are permanent.

## Contract version 1

| Field | Meaning |
| --- | --- |
| `kind` | `harness` drives an external agent CLI that authenticates itself. `direct-provider` is Outright-managed execution against a model API. |
| `modelProvider`, `authority` | The model vendor and where authority comes from. A harness uses its own CLI login. A direct provider names its own environment credential; a harness login never grants API access, and there is no fallback between them. |
| `environment` | Direct providers only: the `OUTRIGHT_*` variables the adapter reads. They are removed from every spawn and handed only to that adapter's process. |
| `detect` | Direct providers only: checks the credential and endpoint settings, so an unusable configuration is reported as unavailable before anything is queued. |
| `versions` | The oldest verified version and the first unverified major. Anything outside the range, or an unparseable `--version`, is reported as incompatible. |
| `capabilities` | Approval policies mapped to native permission modes, suggested models and whether custom names are allowed, reasoning efforts, resume support, structured output (`jsonl`), read-only support and hosted suitability. |
| `sessionIdentity` | The native field carrying the provider's session id. Resume uses only a session created by the same adapter. |
| `buildLaunch`, `normalize` | Argv construction and stream normalization. Positional values follow `--`, so a prompt or session id can never become an option or subcommand. |

Normalized events are `session`, `assistant.delta`, `assistant.message`, `tool.started`, `tool.completed`, `usage`, `provider.failure` and `provider.event`. Usage and failure events keep provider detail under `native`, and unknown records remain `provider.event`. A `provider.failure` marked `terminal: true` (Codex `turn.failed`, a Claude Code `is_error` result, an Anthropic `error` event) fails the run even if the process exits 0. A non-terminal failure, such as a Codex top-level `error` notice that may precede a retry, only explains a nonzero exit.

## Validation order

1. When a run is submitted or recovered, the runtime checks the adapter, approval policy, model name, reasoning effort and resume support against the declared capabilities. Unsupported choices return `409 PROVIDER_CONFIGURATION_UNSUPPORTED` or `PROVIDER_RESUME_UNSUPPORTED`. Malformed values return `400`. Nothing falls back silently.
2. Next, a fresh discovery probe checks availability and version compatibility. A missing provider returns `409 PROVIDER_UNAVAILABLE`, and an out-of-range version returns `409 PROVIDER_INCOMPATIBLE`. Both checks finish before any message or run row is written.
3. At launch, the scheduler builds the argv through the same validation. A queued run that has become invalid fails with that message instead of starting.

Switching a conversation's provider clears its stored session unless the same edit attaches a new one. Attaching a session to a conversation whose adapter cannot resume returns `409 PROVIDER_RESUME_UNSUPPORTED`.

## Credentials and environment

Each run spawn gets a scoped environment. `OUTRIGHT_*` runtime settings are never inherited. A direct provider receives only the `OUTRIGHT_*` variables it declares. Every other subprocess starts from `withoutDirectProviderCredentials()`, which removes the declared variables (case-insensitively, for Windows). That covers harness `--version` probes on every platform, git and gh utilities and the repository hooks they run, and native supervisor control commands. Integrated terminals already drop all `OUTRIGHT_*` variables. Short-lived system tools that Outright runs by absolute path for process inspection (`ps`, `sysctl`, `icacls`, `taskkill`) inherit the runtime environment but never run repository or provider code. A harness CLI inherits the rest of Outright's environment unchanged, and that is its effective authority. For example, Claude Code honours an `ANTHROPIC_API_KEY` exported for Outright, just as it would in a shell. Enabling the direct provider cannot change that, because its key lives in `OUTRIGHT_ANTHROPIC_API_KEY`. The direct provider also never reads `ANTHROPIC_API_KEY`, so a key set up for a harness cannot become direct-provider authority.

The Anthropic runner sends its key only to the configured endpoint. That endpoint must be https or a loopback http address, and discovery applies the same check. Redirects are refused rather than followed. A streamed event is limited to 1 MiB in total, counting every data line that has not yet been dispatched. A malformed event fails the run, but text that has already streamed is kept. The runner waits for stdout to drain, so it stops reading from the API while Outright is not consuming its output.

## Adapters

| Adapter | Kind | Supported versions | Notes |
| --- | --- | --- | --- |
| `codex` | harness | 0.145.0 up to, but not including, 1.0.0 | Sandbox modes map one-to-one. Resume uses `exec resume` with a config override for the sandbox. |
| `claude` | harness | 2.1.296 up to, but not including, 3.0.0 | Policies map to `plan`, `acceptEdits` and `bypassPermissions`. |
| `anthropic-api` | direct-provider | runner 1.x | Requires `OUTRIGHT_ANTHROPIC_API_KEY`. `OUTRIGHT_ANTHROPIC_BASE_URL` optionally overrides the endpoint. It is read-only because it has no tools, does not resume, uses the model's default effort and accepts only https or loopback endpoints. |

Adding an adapter means adding a module, registering it, adding fixtures under `tests/fixtures/execution-adapters/<id>/` (enforced by `server/execution-adapters.test.mjs`) and recording live evidence for its minimum version. Adapters are trusted code shipped with Outright. Loading user-supplied adapters at runtime is out of scope until there is a trust policy for them.

## Deferred to OUT-38

Model, approval policy and reasoning effort are still global defaults, not per-provider ones. A chat switched to `anthropic-api` while the default policy is `workspace-write`, or while the default effort is not `medium`, is therefore rejected with `409 PROVIDER_CONFIGURATION_UNSUPPORTED`. Outright does not substitute a supported value. The error names Settings as the place to change the default. The default-model suggestions also follow the default provider, even though chats on other providers share the same field. Per-provider and per-role execution profiles belong to [OUT-38](https://linear.app/21n/issue/OUT-38/configure-reusable-execution-profiles-per-workflow-task-and-agent-role).
