import request from "supertest";

/**
 * Completes owner approval for a client registered via POST /api/v1/client-auth/register.
 * Requires `approvalToken` on register response (non-production `NODE_ENV`).
 */
export const approveClientRegistrationByToken = async (
  httpTarget: Parameters<typeof request>[0],
  approvalToken: string,
): Promise<void> => {
  const res = await request(httpTarget)
    .post("/api/v1/client-auth/registration/approve")
    .send({ token: approvalToken });
  if (res.status !== 200) {
    throw new Error(`approve client registration failed: ${res.status} ${res.text}`);
  }
};
