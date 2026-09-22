import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

export function runProcess(
  command,
  args,
  { timeout = 60_000, signal, maxOutput = 1_000_000 } = {},
) {
  return new Promise((resolve, reject) => {
    let output = '',
      errorOutput = '',
      failure;
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const timer = setTimeout(() => {
      failure = new AppError('The processing command timed out.', 504);
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (data) => {
      output += data;
      if (output.length > maxOutput) {
        failure = new AppError('Processing output exceeded its limit.', 500);
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (data) => {
      errorOutput = (errorOutput + data).slice(-8192);
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) {
        const e = new AppError(`Processing command failed (exit ${code}).`, 422, 'PROCESS_FAILED');
        e.details = errorOutput;
        reject(e);
      } else resolve(output);
    });
  });
}
