import type { IEmailSender } from "../../domain/ports/email_sender.port";
import { logger } from "../../shared/utils/logger";

export interface ClientAccessRequestEmailInput {
  readonly ownerEmail: string;
  readonly clientEmail: string;
  readonly clientName: string;
  readonly clientLastName: string;
  readonly agentId: string;
  readonly approvalToken: string;
}

/**
 * Sends owner-facing client-access request emails with a bounded
 * concurrency window. Email-sending concerns are isolated here so the
 * caller services do not own retry/parallelism details.
 */
export const sendClientAccessRequestEmails = async (
  emailSender: Pick<IEmailSender, "sendClientAccessRequestToOwner">,
  inputs: readonly ClientAccessRequestEmailInput[],
): Promise<void> => {
  if (inputs.length === 0) {
    return;
  }
  const concurrency = Math.max(1, Math.min(4, inputs.length));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < inputs.length) {
        const input = inputs[nextIndex];
        nextIndex += 1;
        if (input) {
          await emailSender.sendClientAccessRequestToOwner(input);
        }
      }
    }),
  );
};

export const notifyClientAccessApproved = async (
  emailSender: Pick<IEmailSender, "sendClientAccessApproved">,
  clientEmail: string,
  agentId: string,
): Promise<void> => {
  try {
    await emailSender.sendClientAccessApproved({ clientEmail, agentId });
  } catch (error: unknown) {
    logger.error("client_access_approved_email_failed", {
      agentId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export const notifyClientAccessRejected = async (
  emailSender: Pick<IEmailSender, "sendClientAccessRejected">,
  clientEmail: string,
  agentId: string,
  reason?: string,
): Promise<void> => {
  try {
    await emailSender.sendClientAccessRejected({
      clientEmail,
      agentId,
      ...(reason ? { reason } : {}),
    });
  } catch (error: unknown) {
    logger.error("client_access_rejected_email_failed", {
      agentId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
