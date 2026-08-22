/** The caller is not a member of the company they asked for (SPEC §3). */
export class CompanyAccessError extends Error {
  constructor(message = "You do not have access to this company") {
    super(message);
    this.name = "CompanyAccessError";
  }
}

/** The caller is a member but their role does not permit the action (SPEC §2). */
export class RoleError extends Error {
  constructor(message = "Your role does not permit this action") {
    super(message);
    this.name = "RoleError";
  }
}

/** The caller's membership does not include the section they asked for (SPEC §2.1). */
export class SectionError extends Error {
  constructor(message = "You do not have access to this section") {
    super(message);
    this.name = "SectionError";
  }
}

/** A posting was rejected — never swallowed, always surfaced (SPEC §13). */
export class PostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingError";
  }
}

/**
 * Too many attempts in the window (SPEC §13). Distinct from a wrong password so
 * the sign-in screen can say which it was: told "wrong email or password", a
 * throttled person keeps trying, and every attempt extends the lockout.
 */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = "Too many attempts") {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The deployment is missing or misconfiguring something it needs — a storage
 * driver that cannot work on this host, a bucket that was never set up.
 *
 * Distinct from the other errors here because the audience is different: this
 * is not a person doing something they may not, it is an operator who has to
 * change a setting. The message names the setting and is safe to show, which is
 * the whole point — a bare 500 sends someone to the logs to learn something the
 * app already knew.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * A storage call reached the driver and the driver failed — a bucket that does
 * not exist, a key pair that is not accepted, an endpoint pointing nowhere.
 *
 * A `ConfigurationError` because the answer is the same: an operator changes a
 * setting. Distinguished from the plain kind only so the message can carry what
 * the driver actually said, which is the part that names the mistake.
 */
export class StorageUnavailableError extends ConfigurationError {
  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `File storage rejected the ${operation}. Check S3_BUCKET, S3_ENDPOINT, S3_REGION ` +
        `and the access key pair in the deployment's settings, then redeploy. ` +
        `The storage service said: ${detail}`,
    );
    this.name = "StorageUnavailableError";
    this.cause = cause;
  }
}
