/**
 * The one error the CLI reports as a plain message instead of a stack trace:
 * everything a user can get wrong (a bad flag, an unreadable config, a
 * directory that is not a webroot) is a `CliError`.
 */
export class CliError extends Error {
  /** Process exit code. */
  code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}
