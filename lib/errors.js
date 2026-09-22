export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function assert(condition, message, status = 400, code) {
  if (!condition) throw new AppError(message, status, code);
}
