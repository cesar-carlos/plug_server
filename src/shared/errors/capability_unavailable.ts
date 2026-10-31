import { AppError } from "./app_error";
import { isRecord } from "../utils/rpc_types";

export type CapabilityReason = "not_advertised" | "disabled" | "incompatible" | "session_changed";

export const capabilityReason = (advertised: unknown): CapabilityReason =>
  advertised === undefined || advertised === null
    ? "not_advertised"
    : advertised === false || (isRecord(advertised) && advertised.enabled === false)
      ? "disabled"
      : "incompatible";

/** Only for a pre-dispatch refusal: never use this to classify a transport timeout. */
export const capabilityUnavailable = (
  capability: string,
  reason: CapabilityReason,
  origin: "agent" | "hub" = "agent",
): AppError => {
  const peer = origin === "agent" ? "plug_agente consultado" : "plug_server";
  const explanation = {
    not_advertised: "não anunciou suporte a este recurso",
    session_changed: "mudou de conexão ou deixou de estar pronto antes do encaminhamento",
    disabled: "está com este recurso desativado",
    incompatible: "anunciou um contrato ou limites incompatíveis com este recurso",
  }[reason];
  return new AppError(
    `Recurso ${capability} indisponível: o ${peer} ${explanation}. ` +
      "A solicitação não foi encaminhada para execução. Verifique a versão instalada, " +
      "a habilitação e as aprovações locais do recurso; após corrigir, reconecte o agente. " +
      "Não há reenvio automático nem alternativa que remova as garantias solicitadas.",
    {
      statusCode: 409,
      code: "CAPABILITY_UNAVAILABLE",
      details: {
        capability,
        reason,
        origin,
        phase: "preflight",
        recovery: "local_intervention",
        retryable: false,
        effects_possible: false,
        outcome_unknown: false,
      },
    },
  );
};
