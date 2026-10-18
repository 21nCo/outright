# OUT-28 provider accounts and usage

`server/provider-accounts.mjs` owns the account inventory, switching and usage presentation. The scheduler in `server/agent-manager.mjs` asks it which account a launch uses and records the answer on the run.

## Accounts

| Provider | Default account | Added accounts | Identity check |
| --- | --- | --- | --- |
| `claude` | The login of whatever `CLAUDE_CONFIG_DIR` Outright's environment selects | A `CLAUDE_CONFIG_DIR` directory | `claude auth status --json` |
| `codex` | The login of whatever `CODEX_HOME` Outright's environment selects | A `CODEX_HOME` directory | `codex login status` |
| `anthropic-api` | `OUTRIGHT_ANTHROPIC_API_KEY` | None; it is a direct-provider credential, kept separate from harness logins (OUT-3) | The adapter's `detect()` |

An added account is a name and a directory the user owns. The user signs in from a terminal with the CLI itself, for example `CLAUDE_CONFIG_DIR=/path claude auth login`. Outright stores only the resolved directory path and never reads, copies or logs anything inside it. A path that is relative, missing, not a directory, owned by another user (on Windows, outside the user's profile, since Node reports no owner there), already added, or the same as the inherited default is refused with `400 PROVIDER_ACCOUNT_INVALID` or `409 PROVIDER_ACCOUNT_DUPLICATE`. Each provider can have 16 added accounts.

Identity checks run the CLI's own status command through the same supervised probe as version checks, with the account's home variable set and every direct-provider credential removed. An added account's check and launch also drop the CLI's own credential variables, which would otherwise override the login in its home: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` for Claude Code, `CODEX_API_KEY` and `OPENAI_API_KEY` for Codex. The default account keeps them, as part of whatever the environment selects. Both CLIs exit 1 for a signed-out login, which the check accepts. Only display fields are kept: signed in or out, method, email, organization and plan. Codex prints a masked key after an API-key login; only the method is kept. A check that fails or prints something unrecognized is `unknown`, and its message never quotes CLI output. Checks run one at a time, each bounded to 5 seconds, and are cached in memory. A failed check, including a storage fault after its probe, fails only its own callers. A probe whose process tree could not be proven stopped ends identity checks for that CLI until restart, and shutdown reports it, as provider discovery does. Listing accounts checks each account once; **Check** in Settings and every switch check again.

## Switching

`PUT /api/provider-accounts/active { provider, accountId }` checks the account's login first. A signed-out, unknown or removed account fails with `409 PROVIDER_ACCOUNT_SWITCH_FAILED`, and the active account does not change. Switches for one provider apply in request order. A successful switch writes a `provider-account.switched` audit entry naming account ids only.

The active account is a launch-time default:

* A run resolves its account once, when it leaves the queue, and records the account id, its name, the identity known then and the CLI home it launched with (`run_accounts`; null is the CLI's standard home). A deferred admission is still queued and resolves again; once a run is launching, its account cannot change (`409 RUN_ACCOUNT_IMMUTABLE`). The record is written in the same statement that confirms an added account still exists, so an account removed while the launch was prepared fails the run before anything spawns.
* A launch that resumes a session uses the account of the run that last launched in that session. Switching never moves an existing session, and a chat keeps its session's account until the session is cleared. A session created only by runs from before accounts existed used the default login and resumes with it. Only a session no run created (attached by hand) uses the active account.
* The default account follows the environment, so its recorded home matters: a session it created under one home is refused (`409 PROVIDER_ACCOUNT_UNAVAILABLE`, naming both homes) when the environment now selects another, rather than resumed under the wrong login.
* A recovery resume or retry uses the account the interrupted run launched with. The recovery run stores that pin (`run_account_pins`) in the transaction that creates it, so a restart before it launches, and any later recovery of it, keep the account.
* A run that is already running keeps the environment it was spawned with.
* The launch environment sets the account's home variable under its exact name, replacing any other spelling, and drops the credential variables above. The default account changes nothing.

Nothing falls back to another account. A send whose account was removed fails with `409 PROVIDER_ACCOUNT_UNAVAILABLE` before its message or run is written, and a queued run whose account was removed fails at launch with the same explanation. If the last check found the account signed out, a send checks again and fails with `409 PROVIDER_ACCOUNT_SIGNED_OUT` if it still is. Otherwise the CLI reports its own authentication failure. The active account cannot be removed (`409 PROVIDER_ACCOUNT_ACTIVE`), and the default login cannot be removed at all. Removing an account leaves its directory and login untouched, and the runs it launched keep the recorded name.

## Usage

Settings shows two kinds of usage for every account, never mixed:

* **Measured by Outright**: runs launched with the account and its home in the last 5 hours and 7 days, with their tokens and the cost providers reported. Runs without reported tokens or cost are counted separately: a partial sum is shown as "at least", and nothing reported is "not reported", never zero.
* **Reported by the provider**: usage windows from Claude Code's `rate_limit_event`, normalized as the `rate_limit` event with each window's utilization, status and reset time. The latest report of each window wins, whichever run sent it, and it records that run. Windows are filed under the account and home the reporting run launched with; a removed account records none. A window whose reset time has passed is shown as reset, without its old utilization. A report older than 30 minutes is shown as stale with its time. Settings ages the listing while it stays open, at the next reset or stale time and on returning to the tab. A malformed value is dropped rather than guessed. Codex and the Anthropic API do not report usage windows to Outright, so their limits are shown as unavailable, not zero.

Each conversation shows the account of its latest run in the header. Each answer stores the account of the run that produced it, so earlier pages and find results name it too.

## Storage

`provider_accounts`, `provider_account_selection`, `provider_limit_windows`, `run_accounts` and `run_account_pins` are new tables, so the migration is additive and needs no backfill. They count toward the retained-history budget. Adding an account and recording a usage window are optional writes that obey the budget; switching and recording a launch's account are critical writes. `run_accounts` and `run_account_pins` are deleted with their run.

## API

| Route | Result |
| --- | --- |
| `GET /api/provider-accounts` | Every provider with its accounts, active account, login, measured usage and limits |
| `POST /api/provider-accounts` | Add `{ provider, label, homePath }`; `201` with the new listing |
| `PUT /api/provider-accounts/active` | Switch `{ provider, accountId }` |
| `POST /api/provider-accounts/:id/refresh` | Check the account's login again |
| `DELETE /api/provider-accounts/:id` | Remove an added account |

Changes are announced as `provider-accounts.changed`, at most once every 250 ms.
