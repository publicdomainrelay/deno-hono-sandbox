export class SandboxError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
    this.name = "SandboxError";
  }
}
