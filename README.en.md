# dsh-mini-kit

Two small utilities for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), in one package:

| What it does | Where |
|---|---|
| Restart DSH and let the sessions that were **running** carry on after it reopens | the `/restart` slash command and the `restart_dsh` tool |
| Show what is running right now, as workspace + session title | the `list_running_sessions` tool |

`/restart` is for the human (type `/` and it is in the list); the two tools are for the model, so an Agent can restart the app in the middle of its own work and pick the work back up afterwards.

## Install

In DSH Desktop: **Settings → Plugins → Add plugin**, enter `dsh-mini-kit`, or point "from a local directory" at a clone of this repository.

No restart is needed to install — the new bundle activates through HMR, and "Mini Kit" appearing in the plugin list is the success signal.

> The Desktop profile is managed by the application itself, so `dsh plugin --profile desktop add …` is refused (that path is reserved for the app's own carrier). Install through the UI.

## Using it

### `/restart`

Type `/restart` and press Enter. It:

1. lists the sessions with a turn in flight;
2. cancels those turns and waits for them to settle, so the log ends with a real `turn/end` instead of a turn cut in half;
3. records them in `~/.dsh/mini-kit/pending-restart.json`;
4. forces every Session's buffered events to durable storage;
5. ends the DSH process tree and starts `DeepSeek Harness.exe` again;
6. in the new process, reads that record and hands each Session a short "continue", so they carry on by themselves.

**When it is triggered from inside a tool call** (an Agent pressing the button), the caller's own turn is never cancelled by itself — the plugin waits for that turn to end first, up to 60 seconds. Cancelling it would abort the very execution asking for the restart.

### `list_running_sessions`

```
2 running session(s):
- MemoryMate / Fix the login redirect
- Careful S / Tidy the release scripts
```

With nothing running it returns one sentence rather than an empty string.

### `restart_dsh`

The same mechanism as `/restart`; the only difference is the caller. A tool knows which turn it is running inside, so it defers the restart; `/restart` comes from the composer with no turn in flight, so it restarts immediately.

## What a restart actually is, and what it costs

The Desktop shell gives a Host plugin no relaunch interface: the shell validates a fixed set of IPC events, and the preload bridge exposes no relaunch call. So the restart is performed by **a detached helper that outlives the process tree**:

- it asks the app to close (`taskkill` without `/F`, i.e. clicking X) and forces it after `gracefulExitMs`;
- it then kills the Host's own former process explicitly — that process still holds the HTTP port, and leaving it alive makes the relaunched app fail with "another DSH instance is already running";
- it sweeps leftover processes of the same image (orphaned renderers);
- it starts `DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE` removed, because inherited it would start the app as a headless node script with no window.

The honest cost: this is not the app's own quit path. The window flashes and comes back in about 3–5 seconds, and shell state such as window geometry is cut rather than saved. Session data is unaffected, because step 4 has already forced it to disk.

Safety valve: if the parent process is not `DeepSeek Harness.exe` (you ran `dsh web` in a terminal, say), the helper refuses and writes one log line instead of acting.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `autoResume` | `true` | hand the recorded sessions a "continue" after the restart |
| `resumePrompt` | see below | what that message says |
| `resumeDelayMs` | `2500` | how long the fresh process waits before resuming |
| `cancelTimeoutMs` | `20000` | total budget for cancelling the other running turns |
| `quietWaitMs` | `60000` | cap on waiting for the caller's own turn to end |
| `gracefulExitMs` | `3000` | how long the app gets to close before it is forced |
| `relaunchDelayMs` | `800` | delay between handoff and the window going away |
| `stateDir` | empty | override the state directory; empty means `$DSH_HOME/mini-kit` |

The default prompt, in the user's own language:

> DSH 刚刚重启，上一轮工作被中断了。请从中断的地方继续；如果其实已经完成，简要总结一下结果即可。

Set these in the profile's `cordis.patch.yml`. This package deliberately ships **no** `config` block so it never shadows your edits.

## Limits

- **Desktop only.** Under `dsh web` or headless there is no app process to relaunch; the tool explains that, the command returns an error result, and nothing is killed.
- **User sessions only.** Sessions created by a delegated subagent are neither listed nor resumed on their own — their work belongs to the parent that started them.
- "Running" is `Agent.status === 'running'`, i.e. a turn is genuinely advancing right now. Idle sessions are not listed.
- **An unwritable state directory means no restart.** If the sessions to resume cannot be recorded, the app is not closed.
- The record is claimed (renamed to `.claimed`) as it is read, so one failed resume costs one missing prompt instead of restarting the app on every launch.

## Files

```
~/.dsh/mini-kit/pending-restart.json          # what to resume
~/.dsh/mini-kit/pending-restart.json.claimed  # claimed by a process generation
~/.dsh/mini-kit/restart.log                   # what the helper killed, refused, or relaunched
```

When a restart does not happen, read `restart.log` first.

## Development

```sh
npm test
```

The suite needs neither DSH nor a real restart: the restart plan, cancellation, record writing, and resume flow all run against a fake context, and the only two seams replaced are "start the helper process" and "are we the desktop app".

## License

MIT