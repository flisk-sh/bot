# Flisk Bot

A durable Flisk agent that takes jobs from the open jobs board ([flisk-sh/jobs](https://github.com/flisk-sh/jobs), live at https://jobs.flisk.si). Live at https://bot.flisk.si.

It follows the Flisk agent contract (`/health`, `/ready`, `POST /turn` with `x-session-id`, `GET`/`DELETE /session`, `GET /sessions`, idle sweep). Each job it takes is one session, saved after every step, so a restart resumes where it stopped. README scores and AI search checks use Flisk's own tools and no model, so the same input gives the same answer. With a model connected (see below) it also answers questions in the chat box, runs small tasks on a throwaway computer, and takes free-text jobs from the board. Job sessions are never swept; idle chat sessions are (`SESSION_IDLE_TIMEOUT_MS`, `SESSION_CLEANUP_INTERVAL_MS`).

## Run it

Needs [Bun](https://bun.sh) and a jobs board to take jobs from (`JOBS_URL`, see the jobs repo to run one locally).

```bash
bun install
JOBS_URL=http://localhost:4001 bun src/index.ts
```

Tests (fetch the jobs board source into `.jobs/` once first):

```bash
sh scripts/fetch-jobs.sh
bun test
```

## Deploy to Cloudflare (free tier)

```bash
bunx wrangler@4 d1 create flisk-bot   # put the printed id in wrangler.toml
bunx wrangler@4 d1 execute flisk-bot --remote --file migrations/0001_init.sql
bunx wrangler@4 deploy
```

A Worker cannot keep a timer, so the bot takes jobs from a cron trigger (every 5 minutes) instead of a loop; sessions are rows in D1 and the same idle sweep runs on that trigger. Change the `route` in `wrangler.toml` to your own domain.

## The model and the computers (optional)

Without these settings the bot only runs its two tools. With them, the chat box answers any message with the Flisk Wolf model from [inference.flisk.si](https://inference.flisk.si), a task that needs something run gets a fresh computer from [fleet.flisk.si](https://fleet.flisk.si) (deleted when the task ends), and the bot takes free-text jobs from the board. A job it cannot do truthfully goes back to the board at once. The result of a free-text job is a public page on the bot, `/result/<job id>`, with the answer and every command that was run.

| Setting | What it is |
| --- | --- |
| `INFERENCE_KEY` (secret) | A key from inference.flisk.si. Turns the model on. |
| `FLEET_KEY` (secret) | A fleet.flisk.si key of the bot's own fleet login. Turns the computers on. |
| `FLEET_LOGIN` | Only with fleet's trusted-site secret as `FLEET_KEY`: the fleet login to act as. |
| `MODEL_CALLS_PER_DAY` | Default 60. |
| `COMPUTER_TASKS_PER_DAY` | Default 10. |
| `VISITOR_MESSAGES_PER_DAY` | Default 10 messages to the model per visitor. A visitor is a short hash of the address, never the address. |

```bash
bunx wrangler@4 secret put INFERENCE_KEY
bunx wrangler@4 secret put FLEET_KEY
bunx wrangler@4 deploy
```

The fleet login needs one provider connected, once, by its owner (fleet.flisk.si, Connections). The bot never sees a provider key. Anyone can use the chat box without signing in, so the limits are deliberate: 60 seconds per command, 5 actions per task, the caps above (a UTC day), and a computer that holds no secrets and is always deleted.

## The web view is the Run My Agents board

The page at https://bot.flisk.si is the real [Run My Agents](https://github.com/flisk-sh/run-my-agents) board. `bun scripts/sync-rma.ts [path to run-my-agents]` generates `src/rma.generated.ts` from a run-my-agents checkout (default `../run-my-agents`); `rma.ts` turns the bot's sessions into the JSON the board reads. To pick up board changes, run the script again and redeploy.

This repo was split out of `flisk-sh/flisk-bot`, which is now [flisk-sh/jobs](https://github.com/flisk-sh/jobs).

## License

MIT

## @askflisk on X

Post `@askflisk weather in london` and the bot replies with the answer from [chat.flisk.si](https://chat.flisk.si) (the same free model, live weather and web search as chat, fitted to one post). The cron trigger runs every minute (`src/x.ts`; the jobs loop runs on every fifth minute of it, because a free account has only 5 cron triggers), reads new mentions oldest first, answers each once and remembers the newest one (D1 `state`, key `x_since_id`).

1. On chat: `bunx wrangler@4 secret put X_BOT_KEY` (24+ random characters). Chat's `POST /api/answer` answers 404 without it.
2. In developer.x.com, under the admin account (@brookservers), make an app with Read and Write and generate the Access Token and Secret for @askflisk.
3. Here: put `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` and `CHAT_ANSWER_KEY` (the same value as `X_BOT_KEY`) with `bunx wrangler@4 secret put`.
4. Deploy. It starts in a dry run: `bunx wrangler@4 tail` shows `x dry run: @someone asked ... -> ...` and nothing is posted.
5. When the answers look right, set `X_REPLY_LIVE = "1"` in `wrangler.toml` and deploy again.

An app chat built is posted as a screenshot of it, and its link is sent to the asker by DM (X drops posts that carry a link). This needs the Access Token to have Read, Write and Direct Messages permission (regenerate it after changing the app's permissions) and chat's `CF_ACCOUNT_ID` / `CF_BROWSER_TOKEN` for the screenshot. If the DM is refused, or chat has no screenshot, the link goes in the post as before.

@brookservers can post `@askflisk pause` or `@askflisk resume`. A pause drops the mentions that arrive while it lasts. Chat caps each asker at 10 answers and everyone at 500 a day.
