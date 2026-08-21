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
