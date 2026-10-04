import { env } from "../../src/shared/config/env";

type MutableEnv = {
  -readonly [K in keyof typeof env]: (typeof env)[K];
};

/** Test-only write into the readonly `env` object. Production code must not mutate it. */
export const overrideEnv = <K extends keyof typeof env>(
  key: K,
  value: (typeof env)[K],
): void => {
  (env as MutableEnv)[key] = value;
};
