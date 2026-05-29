/**
 * Dev-only helper: signs a /consumers access token for an existing active user.
 * Usage: tsx scripts/make-load-token.ts <userId> [role]
 * Prints only the token to stdout so it can be captured into an env var.
 */
import { signAccessToken } from "../src/shared/utils/jwt";

const userId = process.argv[2]?.trim() || process.env.USER_ID?.trim();
const role = process.argv[3]?.trim() || process.env.USER_ROLE?.trim() || "user";
const principalTypeArg = process.argv[4]?.trim() || process.env.PRINCIPAL_TYPE?.trim() || "user";
const principalType = principalTypeArg === "client" ? "client" : "user";

if (!userId) {
  console.error(
    "Missing userId. Usage: tsx scripts/make-load-token.ts <userId> [role] [principal_type]",
  );
  process.exit(2);
}

const token = signAccessToken({
  sub: userId,
  role,
  principal_type: principalType,
  tokenType: "access",
});

process.stdout.write(token);
