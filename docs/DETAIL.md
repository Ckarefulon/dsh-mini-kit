# Mini Kit

Restart DeepSeek Harness and let the sessions that were running carry on, and ask what is running right now.

## What it adds

Two capabilities, both served from the Host process — this package has no browser half.

- **`/restart`** — a slash command in the composer. It cancels the turns that are in flight, records which sessions they belong to, flushes every session to durable storage, restarts the desktop app, and then hands each recorded session a short "continue" in the new process.
- **`restart_dsh`** — the same operation for the model. It knows which turn it is running inside, so it waits for that turn to end before restarting, up to a limit.
- **`list_running_sessions`** — returns the sessions with a turn in flight as `workspace / session title`, one per line.

## How to use it

Type `/restart` and press Enter. Nothing else is required: the running sessions are the ones that come back, and sessions that were idle stay idle.

Ask the model to "restart DSH" and it calls `restart_dsh`; ask it "what is running" and it calls `list_running_sessions`.

## Limitations worth knowing before you use it

- **Desktop application only.** Under `dsh web` or a headless host there is no application process to relaunch, so the command returns an error result and the tool explains why; neither one touches anything.
- **The restart is a process restart, not the app's own quit path.** The Electron shell exposes no relaunch interface to a Host plugin, so a detached helper ends the process tree and starts the executable again. The window goes away and returns in about three to five seconds.
- **Only user sessions are recorded.** Sessions created by a delegated subagent are neither listed nor resumed on their own; their work belongs to the parent session that started them.
- **"Running" means a turn is advancing right now.** A session that is open but waiting for input is not listed and is not resumed.
- **An unwritable state directory aborts the restart.** If the sessions to resume cannot be recorded, the application is left running rather than closed and half-restored.

## Configuration

Every field has a default and the package ships no configuration block of its own, so values written into the profile's patch layer survive an upgrade of this package.

| Field | Default | Meaning |
|---|---|---|
| `autoResume` | `true` | hand the recorded sessions a "continue" after the restart |
| `resumePrompt` | a short continue instruction | the message each resumed session receives |
| `resumeDelayMs` | `2500` | how long the fresh process waits before resuming |
| `cancelTimeoutMs` | `20000` | total budget for cancelling the other running turns |
| `quietWaitMs` | `60000` | cap on waiting for the caller's own turn to end |
| `gracefulExitMs` | `3000` | how long the application gets to close before it is forced |
| `relaunchDelayMs` | `800` | delay between the handoff and the window going away |
| `stateDir` | empty | override the state directory; empty means `$DSH_HOME/mini-kit` |

## Where its state lives

Under `$DSH_HOME/mini-kit`, which is `~/.dsh/mini-kit` by default: the record of sessions to resume, the claimed copy of that record, and a log written by the helper that performs the restart. When a restart does not happen, that log is the first thing to read.
