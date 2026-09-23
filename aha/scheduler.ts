export type ScheduledJob = {
  name: string;
  everyMs?: number;
  dailyAt?: { hour: number; tz: string };
  run?: () => Promise<void>;
};

export type ScheduleDeps = {
  now?: () => Date;
  intervalMs?: number;
};

export type ScheduleHandle = {
  stop(): void;
  tick(now?: Date): Promise<void>;
};

function parts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(fmt.formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return { ymd: `${map.year}-${map.month}-${map.day}`, hour: Number(map.hour) };
}

function dueDaily(prev: Date, now: Date, hour: number, tz: string, lastYmd: string | undefined) {
  const current = parts(now, tz);
  if (current.ymd === lastYmd) return false;
  if (current.hour === hour) return true;
  const before = parts(prev, tz);
  return before.ymd === current.ymd && before.hour < hour && current.hour > hour;
}

export function schedule(jobs: ScheduledJob[], deps: ScheduleDeps = {}): ScheduleHandle {
  const lastEvery = new Map<string, number>();
  const lastDaily = new Map<string, string>();
  let prev = deps.now?.() ?? new Date();
  let timer: ReturnType<typeof setInterval> | undefined;

  async function tick(explicit?: Date) {
    const now = explicit ?? deps.now?.() ?? new Date();
    for (const job of jobs) {
      try {
        if (job.everyMs !== undefined) {
          const last = lastEvery.get(job.name);
          if (last === undefined) lastEvery.set(job.name, now.getTime());
          else if (now.getTime() - last >= job.everyMs) {
            lastEvery.set(job.name, now.getTime());
            await job.run?.();
          }
        }
        if (job.dailyAt) {
          if (dueDaily(prev, now, job.dailyAt.hour, job.dailyAt.tz, lastDaily.get(job.name))) {
            lastDaily.set(job.name, parts(now, job.dailyAt.tz).ymd);
            await job.run?.();
          }
        }
      } catch (error) {
        console.error(`aha: job ${job.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    prev = now;
  }

  const intervalMs = deps.intervalMs ?? 15_000;
  timer = setInterval(() => { tick().catch(error => console.error(`aha: scheduler: ${error instanceof Error ? error.message : String(error)}`)); }, intervalMs);
  timer.unref?.();

  return {
    async tick(now) { await tick(now); },
    stop() { if (timer) clearInterval(timer); },
  };
}
