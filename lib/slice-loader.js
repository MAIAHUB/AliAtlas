// Background prefetcher for one series. Slices are requested in batches, nearest
// to the displayed slice first (leaning in the scroll direction), and kept in
// memory so scrolling never waits on the network once the series has streamed in.
export const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;

export function prefetchOrder(count, focus, direction = 1) {
  const order = [focus];
  for (let step = 1; order.length < count; step++) {
    for (const index of direction >= 0
      ? [focus + step, focus - step]
      : [focus - step, focus + step])
      if (index >= 0 && index < count) order.push(index);
  }
  return order;
}

export function decodeBatch(buffer, format, frames) {
  const Type = format === 'int16-le' ? Int16Array : Float32Array;
  const expected = frames.reduce((n, f) => n + f.rows * f.columns, 0);
  if (buffer.byteLength !== expected * Type.BYTES_PER_ELEMENT)
    throw new Error('The slice response is incomplete.');
  const result = [];
  let offset = 0;
  for (const frame of frames) {
    const length = frame.rows * frame.columns;
    result.push(new Type(buffer, offset * Type.BYTES_PER_ELEMENT, length));
    offset += length;
  }
  return result;
}

export class SliceLoader {
  constructor({
    frames,
    fetchBatch,
    onLoad,
    onError,
    batchSize = 12,
    concurrency = 3,
    budgetBytes = DEFAULT_BUDGET_BYTES,
  }) {
    this.frames = frames;
    this.fetchBatch = fetchBatch;
    this.onLoad = onLoad;
    this.onError = onError;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.cache = new Map();
    this.pending = new Set();
    this.failures = new Map();
    this.active = 0;
    this.focusIndex = 0;
    this.direction = 1;
    this.disposed = false;
    // Assume 4 bytes per value until the first batch shows the real format.
    const largest = Math.max(...frames.map((f) => f.rows * f.columns), 1);
    this.capacity = Math.max(1, Math.floor(budgetBytes / (largest * 4)));
    this.budgetBytes = budgetBytes;
    this.largest = largest;
  }
  get(frameId) {
    return this.cache.get(frameId);
  }
  get loaded() {
    return this.cache.size;
  }
  focus(index) {
    if (index !== this.focusIndex) this.direction = Math.sign(index - this.focusIndex) || 1;
    this.focusIndex = index;
    this.pump();
  }
  // Indices that should be resident: the whole series, or the nearest slices when it exceeds the budget.
  wanted() {
    return prefetchOrder(this.frames.length, this.focusIndex, this.direction).slice(
      0,
      this.capacity,
    );
  }
  nextBatch() {
    const batch = [];
    for (const index of this.wanted()) {
      const frame = this.frames[index];
      if (this.cache.has(frame.id) || this.pending.has(frame.id)) continue;
      if ((this.failures.get(frame.id) || 0) >= 3) continue;
      batch.push(frame);
      if (batch.length === this.batchSize) break;
    }
    return batch;
  }
  start(batch) {
    this.active++;
    batch.forEach((f) => this.pending.add(f.id));
    this.load(batch).finally(() => {
      this.active--;
      batch.forEach((f) => this.pending.delete(f.id));
      this.pump();
    });
  }
  pump() {
    if (this.disposed) return;
    // The displayed slice jumps the queue alone, even past the concurrency limit,
    // so dragging far along the slider shows the target without waiting for prefetches.
    const focused = this.frames[this.focusIndex];
    if (
      focused &&
      !this.cache.has(focused.id) &&
      !this.pending.has(focused.id) &&
      (this.failures.get(focused.id) || 0) < 3
    )
      this.start([focused]);
    while (this.active < this.concurrency) {
      const batch = this.nextBatch();
      if (!batch.length) return;
      this.start(batch);
    }
  }
  async load(batch) {
    try {
      const { buffer, format } = await this.fetchBatch(batch);
      if (this.disposed) return;
      const pixels = decodeBatch(buffer, format, batch);
      const bytesPerValue = pixels[0].BYTES_PER_ELEMENT;
      this.capacity = Math.max(1, Math.floor(this.budgetBytes / (this.largest * bytesPerValue)));
      batch.forEach((frame, i) => this.cache.set(frame.id, pixels[i]));
      this.evict();
      this.onLoad?.(batch.map((f) => f.id));
    } catch (error) {
      if (this.disposed || error.name === 'AbortError') return;
      batch.forEach((f) => this.failures.set(f.id, (this.failures.get(f.id) || 0) + 1));
      this.onError?.(
        error,
        batch.map((f) => f.id),
      );
    }
  }
  evict() {
    if (this.cache.size <= this.capacity) return;
    const keep = new Set(this.wanted().map((i) => this.frames[i].id));
    for (const id of this.cache.keys()) if (!keep.has(id)) this.cache.delete(id);
  }
  dispose() {
    this.disposed = true;
    this.cache.clear();
  }
}
