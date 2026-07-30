/**
 * A second run was asked for while one was still going. Tickets execute strictly
 * one at a time, and so do runs — the Supervisor drives one project.
 */
export class QueueRunInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueRunInProgressError";
  }
}
