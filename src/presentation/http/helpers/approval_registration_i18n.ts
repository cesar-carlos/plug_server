export type ApprovalHtmlLang = "pt-BR" | "en";

export interface UserRegistrationReviewCopy {
  readonly title: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly approveLabel: string;
  readonly rejectLabel: string;
  readonly reasonLabel: string;
  readonly textareaPlaceholder: string;
  readonly actionsAriaLabel: string;
  readonly summaryUserEmail: string;
  readonly summaryAccountStatus: string;
  readonly summaryLinkStatus: string;
}

export const userRegistrationReviewCopy = (lang: ApprovalHtmlLang): UserRegistrationReviewCopy => {
  if (lang === "pt-BR") {
    return {
      title: "Rever registo",
      eyebrow: "Aprovação de utilizador",
      description:
        "Aprove a conta apenas se este registo for esperado. Pedidos GET não alteram dados.",
      approveLabel: "Aprovar registo",
      rejectLabel: "Recusar registo",
      reasonLabel: "Nota opcional para o utilizador (máx. 500 caracteres)",
      textareaPlaceholder: "Nota opcional",
      actionsAriaLabel: "Ações de aprovação",
      summaryUserEmail: "E-mail do utilizador",
      summaryAccountStatus: "Estado da conta",
      summaryLinkStatus: "Estado do link",
    };
  }
  return {
    title: "Review registration",
    eyebrow: "User approval",
    description:
      "Approve the account only if this registration is expected. GET requests do not change data.",
    approveLabel: "Approve registration",
    rejectLabel: "Reject registration",
    reasonLabel: "Optional note to the user (max 500 characters)",
    textareaPlaceholder: "Optional note",
    actionsAriaLabel: "Approval actions",
    summaryUserEmail: "User email",
    summaryAccountStatus: "Account status",
    summaryLinkStatus: "Link status",
  };
};

export interface ClientRegistrationReviewCopy {
  readonly title: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly approveLabel: string;
  readonly rejectLabel: string;
  readonly reasonLabel: string;
  readonly textareaPlaceholder: string;
  readonly actionsAriaLabel: string;
  readonly summaryOwnerEmail: string;
  readonly summaryClient: string;
  readonly summaryClientEmail: string;
  readonly summaryAccountStatus: string;
  readonly summaryLinkStatus: string;
}

export const clientRegistrationReviewCopy = (
  lang: ApprovalHtmlLang,
): ClientRegistrationReviewCopy => {
  if (lang === "pt-BR") {
    return {
      title: "Rever registo de cliente",
      eyebrow: "Aprovação de cliente",
      description:
        "Aprove este cliente apenas se deve operar na sua conta. Pedidos GET não alteram dados.",
      approveLabel: "Aprovar registo do cliente",
      rejectLabel: "Recusar registo do cliente",
      reasonLabel: "Nota opcional para o cliente (máx. 500 caracteres)",
      textareaPlaceholder: "Nota opcional",
      actionsAriaLabel: "Ações de aprovação",
      summaryOwnerEmail: "E-mail do responsável",
      summaryClient: "Cliente",
      summaryClientEmail: "E-mail do cliente",
      summaryAccountStatus: "Estado da conta",
      summaryLinkStatus: "Estado do link",
    };
  }
  return {
    title: "Review client registration",
    eyebrow: "Client approval",
    description:
      "Approve this client only if it should operate under your account. GET requests do not change data.",
    approveLabel: "Approve client registration",
    rejectLabel: "Reject client registration",
    reasonLabel: "Optional note to the client (max 500 characters)",
    textareaPlaceholder: "Optional note",
    actionsAriaLabel: "Approval actions",
    summaryOwnerEmail: "Owner email",
    summaryClient: "Client",
    summaryClientEmail: "Client email",
    summaryAccountStatus: "Account status",
    summaryLinkStatus: "Link status",
  };
};

export interface ClientAccessReviewCopy {
  readonly title: string;
  readonly eyebrow: string;
  readonly description: string;
  readonly approveLabel: string;
  readonly rejectLabel: string;
  readonly reasonLabel: string;
  readonly textareaPlaceholder: string;
  readonly actionsAriaLabel: string;
  readonly summaryClient: string;
  readonly summaryEmail: string;
  readonly summaryAgent: string;
  readonly summaryRequestStatus: string;
  readonly summaryLinkStatus: string;
  readonly readOnlyInvalid: string;
  readonly readOnlyExpired: string;
  readonly readOnlyResolved: (requestStatus: string) => string;
}

export const clientAccessReviewCopy = (lang: ApprovalHtmlLang): ClientAccessReviewCopy => {
  if (lang === "pt-BR") {
    return {
      title: "Revisar acesso do cliente",
      eyebrow: "Aprovação de acesso ao agente",
      description:
        "Aprovar somente se o cliente deve acessar este agente. Requisições GET não alteram dados.",
      approveLabel: "Aprovar acesso",
      rejectLabel: "Recusar acesso",
      reasonLabel: "Mensagem opcional para o cliente (máx. 500 caracteres)",
      textareaPlaceholder: "Nota opcional",
      actionsAriaLabel: "Ações de aprovação",
      summaryClient: "Cliente",
      summaryEmail: "E-mail",
      summaryAgent: "Agente",
      summaryRequestStatus: "Status do pedido",
      summaryLinkStatus: "Status do link",
      readOnlyInvalid:
        "Este link é inválido, expirou ou já foi utilizado. Nenhuma ação é necessária nesta página.",
      readOnlyExpired:
        "Este link de aprovação expirou. Se o acesso ainda for necessário, o cliente pode solicitar novamente.",
      readOnlyResolved: (requestStatus: string) =>
        `Este pedido de acesso já foi resolvido (status: ${requestStatus}).`,
    };
  }
  return {
    title: "Review client access",
    eyebrow: "Agent access approval",
    description:
      "Approve only if this client should access this agent. GET requests do not change data.",
    approveLabel: "Approve access",
    rejectLabel: "Deny access",
    reasonLabel: "Optional message to the client (max 500 characters)",
    textareaPlaceholder: "Optional note",
    actionsAriaLabel: "Approval actions",
    summaryClient: "Client",
    summaryEmail: "Email",
    summaryAgent: "Agent",
    summaryRequestStatus: "Request status",
    summaryLinkStatus: "Link status",
    readOnlyInvalid:
      "This link is invalid, expired, or has already been used. No action is required on this page.",
    readOnlyExpired:
      "This approval link has expired. If access is still needed, the client can request it again.",
    readOnlyResolved: (requestStatus: string) =>
      `This access request was already resolved (status: ${requestStatus}).`,
  };
};

export interface ClientAccessDecisionCopy {
  readonly approvedTitle: string;
  readonly approvedBody: (agentId: string) => string;
  readonly rejectedTitle: string;
  readonly rejectedBody: (agentId: string) => string;
}

export const clientAccessDecisionCopy = (lang: ApprovalHtmlLang): ClientAccessDecisionCopy => {
  if (lang === "pt-BR") {
    return {
      approvedTitle: "Acesso aprovado",
      approvedBody: (agentId: string) => `O cliente agora tem acesso ao agente ${agentId}.`,
      rejectedTitle: "Acesso recusado",
      rejectedBody: (agentId: string) =>
        `A solicitação de acesso ao agente ${agentId} foi recusada.`,
    };
  }
  return {
    approvedTitle: "Access approved",
    approvedBody: (agentId: string) => `The client now has access to agent ${agentId}.`,
    rejectedTitle: "Access denied",
    rejectedBody: (agentId: string) => `The access request for agent ${agentId} was denied.`,
  };
};

export interface UserRegistrationDecisionCopy {
  readonly approvedTitle: string;
  readonly approvedBody: (email: string) => string;
  readonly rejectedTitle: string;
  readonly rejectedBody: (email: string) => string;
}

export const userRegistrationDecisionCopy = (
  lang: ApprovalHtmlLang,
): UserRegistrationDecisionCopy => {
  if (lang === "pt-BR") {
    return {
      approvedTitle: "Registo aprovado",
      approvedBody: (email: string) => `A conta ${email} já pode iniciar sessão.`,
      rejectedTitle: "Registo recusado",
      rejectedBody: (email: string) => `O registo para ${email} não foi aprovado.`,
    };
  }
  return {
    approvedTitle: "Registration approved",
    approvedBody: (email: string) => `The account ${email} can now sign in.`,
    rejectedTitle: "Registration rejected",
    rejectedBody: (email: string) => `The registration for ${email} was not approved.`,
  };
};

export interface ClientRegistrationDecisionCopy {
  readonly approvedTitle: string;
  readonly approvedBody: (clientEmail: string) => string;
  readonly rejectedTitle: string;
  readonly rejectedBody: (clientEmail: string) => string;
}

export const clientRegistrationDecisionCopy = (
  lang: ApprovalHtmlLang,
): ClientRegistrationDecisionCopy => {
  if (lang === "pt-BR") {
    return {
      approvedTitle: "Registo de cliente aprovado",
      approvedBody: (clientEmail: string) =>
        `A conta de cliente ${clientEmail} já pode iniciar sessão.`,
      rejectedTitle: "Registo de cliente recusado",
      rejectedBody: (clientEmail: string) => `O registo para ${clientEmail} não foi aprovado.`,
    };
  }
  return {
    approvedTitle: "Client registration approved",
    approvedBody: (clientEmail: string) => `The client account ${clientEmail} can now sign in.`,
    rejectedTitle: "Client registration rejected",
    rejectedBody: (clientEmail: string) => `The registration for ${clientEmail} was not approved.`,
  };
};

export const approvalHomeLabel = (lang: ApprovalHtmlLang): string =>
  lang === "pt-BR" ? "Voltar à aplicação" : "Back to the app";

export const approvalDecisionEyebrow = (lang: ApprovalHtmlLang): string =>
  lang === "pt-BR" ? "Decisão registrada" : "Decision recorded";
