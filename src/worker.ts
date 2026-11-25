// Flisk Bot as a Cloudflare Worker (bot.flisk.si): the same app as index.ts, sessions in D1. A Worker cannot keep a
// timer, so a cron trigger runs one pass of the work loop and the idle sweep.
import { createBot } from './app';
import { fleetComputer, wolfModel } from './brain';
import { withSecurityHeaders } from './security-headers';
import { sendTrace, traced, type TraceEnv } from './trace';
import { d1Store, type D1Like } from './stores';
import { bskyPass, type BskyEnv } from './bluesky';
import { xPass, type XEnv } from './x';

interface Env extends TraceEnv, Omit<XEnv, 'DB'>, Omit<BskyEnv, 'DB'> {
  DB: D1Like;
  JOBS_URL: string;
  JOBS_PUBLIC_URL?: string;
  BOT_NAME?: string;
  BOT_HOMEPAGE?: string;
  SESSION_IDLE_TIMEOUT_MS?: string;
  /** Secret. Set: the bot answers with the Flisk Wolf model. Not set: Flisk's own tools only. */
  INFERENCE_KEY?: string;
  INFERENCE_URL?: string;
  INFERENCE_MODEL?: string;
  /** The inference Worker, bound: a Worker cannot call another Worker of the same account by its public address. */
  INFERENCE?: { fetch: typeof fetch };
  /** Secret. A fleet key of the bot's own fleet login, or fleet's trusted-site secret together with FLEET_LOGIN. */
  FLEET_KEY?: string;
  FLEET_URL?: string;
  FLEET_LOGIN?: string;
  MODEL_CALLS_PER_DAY?: string;
  COMPUTER_TASKS_PER_DAY?: string;
  VISITOR_MESSAGES_PER_DAY?: string;
}

const bots = new WeakMap<object, ReturnType<typeof createBot>>();
function botFor(env: Env) {
  let b = bots.get(env);
  if (!b) {
    const jobsUrl = (env.JOBS_URL || '').replace(/\/+$/, '');
    b = createBot(
      {
        name: env.BOT_NAME || 'Flisk Bot',
        boardUrl: (env.JOBS_PUBLIC_URL || jobsUrl).replace(/\/+$/, ''),
        jobsUrl,
        homepage: env.BOT_HOMEPAGE,
        fleetUrl: env.FLEET_URL,
        idleTimeoutMs: Number(env.SESSION_IDLE_TIMEOUT_MS) || 86_400_000,
        durability: 'd1',
        // Workers Free allows 50 subrequests per run; a job costs about 6, so three leaves room for resuming others.
        jobsPerPass: 3,
        brain: env.INFERENCE_KEY
          ? {
              model: wolfModel({ key: env.INFERENCE_KEY, url: env.INFERENCE_URL, model: env.INFERENCE_MODEL, binding: env.INFERENCE }),
              computer: env.FLEET_KEY ? fleetComputer({ key: env.FLEET_KEY, url: env.FLEET_URL, login: env.FLEET_LOGIN }) : null,
              modelCallsPerDay: Number(env.MODEL_CALLS_PER_DAY) || undefined,
              computerTasksPerDay: Number(env.COMPUTER_TASKS_PER_DAY) || undefined,
              visitorMessagesPerDay: Number(env.VISITOR_MESSAGES_PER_DAY) || undefined,
            }
          : undefined,
      },
      d1Store(env.DB),
    );
    bots.set(env, b);
  }
  return b;
}

export default {
  // Every response carries the baseline security headers (see security-headers.ts). The root answers 404 JSON for any path the bot
  // does not know, and those errors get the headers too.
  fetch: async (req: Request, env: Env) => withSecurityHeaders(await botFor(env).handle(req)),
  async scheduled(event: { cron?: string; scheduledTime?: number }, env: Env) {
    // One trigger, every minute (a free account has only 5 cron triggers): answer new @askflisk mentions on X and Bluesky every minute,
    // and run the jobs board work loop on every fifth minute.
    try {
      const r = await xPass(env);
      if (r.stopped && r.stopped !== 'not configured' && r.stopped !== 'paused') await sendTrace(env, { route: '/x', kind: 'error', why: `the X pass stopped: ${r.stopped}`.slice(0, 150) });
    } catch (e) {
      await sendTrace(env, { route: '/x', kind: 'error', why: `the X pass threw: ${String((e as Error)?.message || e).slice(0, 120)}` });
    }
    try {
      const r = await bskyPass(env);
      if (r.stopped && r.stopped !== 'not configured' && r.stopped !== 'paused' && r.stopped !== 'reply cap reached for now') await sendTrace(env, { route: '/bluesky', kind: 'error', why: `the Bluesky pass stopped: ${r.stopped}`.slice(0, 150) });
    } catch (e) {
      await sendTrace(env, { route: '/bluesky', kind: 'error', why: `the Bluesky pass threw: ${String((e as Error)?.message || e).slice(0, 120)}` });
    }
    if (new Date(event?.scheduledTime ?? Date.now()).getUTCMinutes() % 5 !== 0) return;
    try {
      const bot = botFor(env);
      await bot.pass();
      await bot.sweep();
    } catch (e) {
      await sendTrace(env, { route: '/cron', kind: 'error', why: `the work loop threw: ${String((e as Error)?.message || e).slice(0, 150)}` });
      throw e;
    }
  },
};
