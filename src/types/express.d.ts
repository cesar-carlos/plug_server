import type { User } from "../domain/entities/user.entity";

declare global {
  namespace Express {
    interface Locals {
      /** Set by `requireActiveAccount` after a successful DB check (not blocked). */
      activeAccountUser?: User;
    }
  }
}

export {};
