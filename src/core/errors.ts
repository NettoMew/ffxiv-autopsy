/** 面向使用者的错误：消息会被直接打印，不带堆栈。 */
export class UserError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UserError";
    this.hint = hint;
  }
}

export function fail(message: string, hint?: string): never {
  throw new UserError(message, hint);
}
