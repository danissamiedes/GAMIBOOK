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

/** A posting was rejected — never swallowed, always surfaced (SPEC §13). */
export class PostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingError";
  }
}
