// Timing for anatomy jobs. The worker records when each step starts and ends and
// learns seconds-per-slice for each model task on this hardware; the UI turns that
// into a live elapsed clock, remaining-time estimate and per-step timeline.

export const statsKey = (task, device, fast) =>
  `${task}|${device || 'cpu'}|${task === 'total' && fast ? 'fast' : 'full'}`;

// Exponential moving average, so estimates follow hardware or driver changes.
export function learn(stats, key, seconds, frames) {
  const perFrame = seconds / Math.max(1, frames);
  const previous = stats[key];
  return {
    ...stats,
    [key]: previous
      ? {
          secondsPerFrame: previous.secondsPerFrame * 0.5 + perFrame * 0.5,
          runs: previous.runs + 1,
        }
      : { secondsPerFrame: perFrame, runs: 1 },
  };
}

export const estimateFor = (stats, key, frames) =>
  stats[key] ? Math.round(stats[key].secondsPerFrame * frames) : null;

const seconds = (from, to) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);

export function jobTiming(job, now = new Date().toISOString()) {
  const steps = (job.steps || []).map((step) => {
    const state = step.finishedAt ? 'done' : step.startedAt ? 'running' : 'pending';
    return {
      ...step,
      state,
      seconds: step.startedAt ? seconds(step.startedAt, step.finishedAt || now) : 0,
    };
  });
  const finished = ['completed', 'failed'].includes(job.status);
  const elapsed = job.startedAt ? seconds(job.startedAt, job.finishedAt || now) : 0;
  const queued = seconds(job.createdAt, job.startedAt || (finished ? job.finishedAt : now));
  let remaining = null;
  if (!finished && job.status === 'running') {
    // Only model steps are estimated; preparing and saving take seconds.
    const open = steps.filter((s) => s.estimated && s.state !== 'done');
    if (open.every((s) => s.estimateSeconds != null))
      remaining = open.reduce(
        (n, s) =>
          n +
          (s.state === 'running'
            ? // Past its estimate, assume a little more time rather than zero.
              Math.max(s.estimateSeconds - s.seconds, Math.min(30, s.estimateSeconds * 0.1))
            : s.estimateSeconds),
        0,
      );
  }
  const progress =
    job.status === 'completed'
      ? 100
      : remaining != null && elapsed + remaining > 0
        ? Math.min(99, Math.round((elapsed / (elapsed + remaining)) * 100))
        : job.progress || 0;
  return { steps, elapsed, queued, remaining, progress, finished };
}

export function formatDuration(total) {
  if (total == null) return '—';
  const s = Math.round(total),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
