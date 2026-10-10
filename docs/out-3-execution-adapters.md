# OUT-3 execution adapter contract

The scheduler in `server/agent-manager.mjs` owns supervision, persistence, recovery and capacity. Everything provider-specific lives in an adapter under `server/execution-adapters/`, and the registry in `index.mjs` is the only list of providers. Persisted conversations and runs store the adapter id, so ids are permanent.

## Contract version 1

| Field | Meaning |
| --- | --- |
| `kind` | `harness` drives an external agent CLI that authenticates itself. `direct-provider` is Outright-managed execution against a model API. |
| `modelProvider`, `authority` | The model vendor and where authority comes from. A harness uses its own CLI login. A direct provider names its own environment credential; a harness login never grants API access, and there is no fallback between them. |
| `versions` | The oldest verified version and the first unverified major. Anything outside the range, or an unparseable `--version`, is reported as incompatible. |
| `capabilities` | Approval policies mapped to native permission modes, suggested models and whether custom names are allowed, reasoning efforts, resume support, structured output (`jsonl`), read-only support and hosted suitability. |
| `sessionIdentity` | The native field carrying the provider's session id. Resume uses only a session created by the same adapter. |
| `buildLaunch`, `normalize` | Argv construction and stream normalization. Positional values follow `--`, so a prompt or session id can never become an option or subcommand. |

Normalized events are `session`, `assistant.delta`, `assistant.message`, `tool.started`, `tool.completed`, `usage`, `provider.failure` and `provider.event`. Usage and failure events keep provider detail under `native`, and unknown records remain `provider.event`.

## Validation order

1. When a run is submitted or recovered, the runtime checks the adapter, approval policy, model name, reasoning effort and resume support against the declared capabilities. Unsupported choices return `409 PROVIDER_CONFIGURATION_UNSUPPORTED` or `PROVIDER_RESUME_UNSUPPORTED`. Malformed values return `400`. Nothing falls back silently.
2. Next, a fresh discovery probe checks availability and version compatibility. A missing provider returns `409 PROVIDER_UNAVAILABLE`, and an out-of-range version returns `409 PROVIDER_INCOMPATIBLE`. Both checks finish before any message or run row is written.
3. At launch, the scheduler builds the argv through the same validation. A queued run that has become invalid fails with that message instead of starting.

Switching a conversation's provider clears its stored session unless the same edit attaches a new one.

## Adapters

| Adapter | Kind | Supported versions | Notes |
| --- | --- | --- | --- |
| `codex` | harness | 0.145.0 up to, but not including, 1.0.0 | Sandbox modes map one-to-one. Resume uses `exec resume` with a config override for the sandbox. |
| `claude` | harness | 2.1.296 up to, but not including, 3.0.0 | Policies map to `plan`, `acceptEdits` and `bypassPermissions`. |
| `anthropic-api` | direct-provider | runner 1.x | Requires `ANTHROPIC_API_KEY`. It is read-only because it has no tools, does not resume, uses the model's default effort and accepts only https or loopback endpoints. |

Adding an adapter means adding a module, registering it, adding fixtures under `tests/fixtures/execution-adapters/<id>/` (enforced by `server/execution-adapters.test.mjs`) and recording live evidence for its minimum version. Adapters are trusted code shipped with Outright. Loading user-supplied adapters at runtime is out of scope until there is a trust policy for them.
