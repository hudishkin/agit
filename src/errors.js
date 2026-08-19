export class AgitError extends Error {
  constructor({ code, message, hint = null, details = null, exitCode = 1 }) {
    super(message);
    this.name = "AgitError";
    this.code = code;
    this.hint = hint;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export class NotInitialized extends AgitError {
  constructor(message, hint = "Run agit init --yes first.", details = null) {
    super({ code: "not_initialized", message, hint, details, exitCode: 2 });
    this.name = "NotInitialized";
  }
}

export class DirtyTree extends AgitError {
  constructor(message, hint = "Commit the changes, or remove them, then retry.", details = null) {
    super({ code: "dirty_tree", message, hint, details, exitCode: 3 });
    this.name = "DirtyTree";
  }
}

export class WrongBranch extends AgitError {
  constructor(message, hint = "Use agit start <task-id> and stay on that branch.", details = null) {
    super({ code: "wrong_branch", message, hint, details, exitCode: 4 });
    this.name = "WrongBranch";
  }
}

export class DenylistHit extends AgitError {
  constructor(message, hint = "Remove secret files from the change set and retry.", details = null) {
    super({ code: "denylist_hit", message, hint, details, exitCode: 5 });
    this.name = "DenylistHit";
  }
}

export class ChecksFailed extends AgitError {
  constructor(message, hint = "Fix the errors and run agit finish again.", details = null) {
    super({ code: "checks_failed", message, hint, details, exitCode: 6 });
    this.name = "ChecksFailed";
  }
}

export class PublishFailed extends AgitError {
  constructor(message, hint = "Fix the remote error and run agit finish again.", details = null) {
    super({ code: "publish_failed", message, hint, details, exitCode: 7 });
    this.name = "PublishFailed";
  }
}

export class TaskStateError extends AgitError {
  constructor(message, hint = "Run agit status and follow the hint.", details = null) {
    super({ code: "task_state", message, hint, details, exitCode: 8 });
    this.name = "TaskStateError";
  }
}

export class EmptyCommit extends AgitError {
  constructor(message = "Nothing to commit.", hint = "Make a change first.", details = null) {
    super({ code: "empty_commit", message, hint, details, exitCode: 9 });
    this.name = "EmptyCommit";
  }
}
