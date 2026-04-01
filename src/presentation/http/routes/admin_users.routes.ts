import { Router } from "express";

import { patchUserStatus } from "../controllers/admin_users.controller";
import { asyncHandler } from "../middlewares/async_handler";
import { requireAuthAndActiveAccount, requireRole } from "../middlewares/auth.middleware";
import { adminUserStatusRateLimit } from "../middlewares/rate_limit.middleware";
import { validateRequest } from "../middlewares/validate.middleware";
import {
  adminSetUserStatusBodySchema,
  adminUserIdParamSchema,
} from "../validators/admin_users.validator";

export const adminUsersRouter = Router();

/**
 * @openapi
 * /admin/users/{id}/status:
 *   patch:
 *     summary: Block or unblock a user account (admin)
 *     description: >
 *       Sets status to `blocked` (revokes all refresh tokens for that user) or `active` to unblock.
 *       Pending accounts cannot be activated here; use registration approval. Reactivation via `active` is only for previously blocked users.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, blocked]
 *     responses:
 *       200:
 *         description: Updated user summary
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: User not found
 *       429:
 *         description: Too many status updates for this admin (rate limited)
 */
adminUsersRouter.patch(
  "/:id/status",
  ...requireAuthAndActiveAccount,
  requireRole("admin"),
  adminUserStatusRateLimit,
  validateRequest({ params: adminUserIdParamSchema, body: adminSetUserStatusBodySchema }),
  asyncHandler(patchUserStatus),
);
