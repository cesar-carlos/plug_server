import request from "supertest";

/**
 * Completes admin approval for a user registered via POST /api/v1/auth/register.
 * Requires `approvalToken` on the register response (non-production `NODE_ENV`).
 */
export const approveRegistrationByToken = async (
  httpTarget: Parameters<typeof request>[0],
  approvalToken: string,
): Promise<void> => {
  const res = await request(httpTarget)
    .post("/api/v1/auth/registration/approve")
    .send({ token: approvalToken });
  if (res.status !== 200) {
    throw new Error(`approve registration failed: ${res.status} ${res.text}`);
  }
};
