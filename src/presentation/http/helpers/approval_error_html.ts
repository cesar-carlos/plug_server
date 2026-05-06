import type { Request } from "express";
import type { ZodError } from "zod";

import { env } from "../../../shared/config/env";
import type { AppError } from "../../../shared/errors/app_error";
import { renderApprovalErrorPage } from "./approval_pages";
import { normalizeZodIssues } from "../middlewares/validate.middleware";

export type ApprovalErrorHtmlRoute = "client_access" | "user_registration" | "client_registration" | null;

const stripQuery = (url: string | undefined): string => {
  if (url === undefined || url === "") {
    return "";
  }
  return url.split("?")[0] ?? "";
};

const routeFromPath = (urlPath: string): ApprovalErrorHtmlRoute => {
  if (urlPath.includes("/client-access/approve") || urlPath.includes("/client-access/reject")) {
    return "client_access";
  }
  if (urlPath.includes("/auth/registration/approve") || urlPath.includes("/auth/registration/reject")) {
    return "user_registration";
  }
  if (
    urlPath.includes("/client-auth/registration/approve") ||
    urlPath.includes("/client-auth/registration/reject")
  ) {
    return "client_registration";
  }
  return null;
};

/**
 * Browsers that submit the HTML approval/reject forms use
 * `application/x-www-form-urlencoded` and `Accept: text/html`.
 * JSON API clients use `application/json` and get JSON error bodies.
 */
export const isBrowserLikeApprovalErrorRequest = (request: Request): boolean => {
  const contentType = (request.get("Content-Type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    return false;
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return true;
  }
  const accept = (request.get("Accept") ?? "").toLowerCase();
  if (accept.includes("text/html")) {
    return true;
  }
  return false;
};

export const isApprovalFormPostErrorRoute = (request: Request): boolean => {
  const path = stripQuery(request.originalUrl ?? request.path);
  return routeFromPath(path) !== null;
};

export const shouldReturnHtmlForApprovalError = (request: Request): boolean =>
  isApprovalFormPostErrorRoute(request) && isBrowserLikeApprovalErrorRequest(request);

const homeFooter = (): { homeUrl: string; homeLabel: string } => {
  const homeUrl = env.appBaseUrl.replace(/\/+$/, "");
  return { homeUrl, homeLabel: "Back to the app" };
};

const localeFromRoute = (route: ApprovalErrorHtmlRoute): "pt" | "en" =>
  route === "client_access" ? "pt" : "en";

const bodyTextForClientAccess = (error: AppError): string => {
  switch (error.code) {
    case "REGISTRATION_TOKEN_EXPIRED":
      return "Este link de aprovação expirou. Se ainda fizer sentido, peça para o cliente solicitar acesso de novo.";
    case "CONFLICT":
      if (String(error.message).toLowerCase().includes("processed")) {
        return "Este pedido de acesso já foi processado.";
      }
      return error.message;
    case "TOO_MANY_REQUESTS":
      return "Muitas tentativas. Aguarde um instante e tente de novo.";
    case "SERVICE_UNAVAILABLE":
      return "Serviço temporariamente indisponível. Tente novamente em instantes.";
    case "NOT_FOUND":
      return "Este link é inválido, já foi utilizado ou o pedido não existe mais.";
    case "FORBIDDEN":
      return error.message;
    default:
      if (error.statusCode >= 500) {
        return "Ocorreu um erro no servidor. Tente novamente mais tarde.";
      }
      return error.message;
  }
};

const titleForAppError = (error: AppError, locale: "pt" | "en"): string => {
  if (locale === "en") {
    if (error.statusCode === 400) {
      return "Request not completed";
    }
    if (error.statusCode === 403) {
      return "Forbidden";
    }
    if (error.statusCode === 404) {
      return "Request not found";
    }
    if (error.statusCode === 409) {
      return "Already processed";
    }
    if (error.statusCode === 410) {
      return "Link no longer valid";
    }
    if (error.statusCode === 429) {
      return "Too many attempts";
    }
    if (error.statusCode === 503) {
      return "Service unavailable";
    }
    if (error.statusCode >= 500) {
      return "Error";
    }
    return "Request not completed";
  }
  if (error.statusCode === 403) {
    return "Não autorizado";
  }
  if (error.statusCode === 400) {
    return "Não foi possível concluir";
  }
  if (error.statusCode === 404) {
    return "Link ou pedido não encontrado";
  }
  if (error.statusCode === 409) {
    return "Conflito";
  }
  if (error.statusCode === 410) {
    return "Link expirado";
  }
  if (error.statusCode === 429) {
    return "Limite de tentativas";
  }
  if (error.statusCode === 503) {
    return "Serviço indisponível";
  }
  if (error.statusCode >= 500) {
    return "Erro no servidor";
  }
  return "Não foi possível concluir";
};

const buildZodText = (error: ZodError, locale: "pt" | "en"): string => {
  const issues = normalizeZodIssues(error);
  const first = issues[0];
  if (first && typeof first === "object" && "message" in first) {
    const f = first as { field: string; message: string };
    if (f.message && f.field) {
      return f.field === "root" ? f.message : `${f.field}: ${f.message}`;
    }
  }
  if (locale === "pt") {
    return "Não foi possível validar os dados enviados. Verifique o formulário e tente de novo.";
  }
  return "The request could not be validated. Check the form fields and try again.";
};

export const buildApprovalErrorHtml = (
  request: Request,
  error: AppError,
  requestId?: string,
): { statusCode: number; html: string } | null => {
  const path = stripQuery(request.originalUrl ?? request.path);
  const group = routeFromPath(path);
  if (group === null) {
    return null;
  }
  const { homeUrl, homeLabel } = homeFooter();
  const loc = localeFromRoute(group);
  const isPt = loc === "pt";
  const body = group === "client_access" ? bodyTextForClientAccess(error) : error.message;
  return {
    statusCode: error.statusCode,
    html: renderApprovalErrorPage({
      title: titleForAppError(error, loc),
      bodyText: body,
      lang: isPt ? "pt-BR" : "en",
      eyebrow: isPt ? "Algo deu errado" : "Something went wrong",
      ...(requestId
        ? { detailsText: isPt ? `ID da solicitação: ${requestId}` : `Request ID: ${requestId}` }
        : {}),
      homeUrl,
      homeLabel: isPt ? "Voltar ao início" : homeLabel,
    }),
  };
};

export const buildApprovalZodErrorHtml = (
  request: Request,
  error: ZodError,
  requestId?: string,
): { html: string } | null => {
  const path = stripQuery(request.originalUrl ?? request.path);
  const group = routeFromPath(path);
  if (group === null) {
    return null;
  }
  const { homeUrl, homeLabel } = homeFooter();
  const loc = localeFromRoute(group);
  const isPt = loc === "pt";
  return {
    html: renderApprovalErrorPage({
      title: isPt ? "Dados inválidos" : "Invalid request",
      bodyText: buildZodText(error, loc),
      lang: isPt ? "pt-BR" : "en",
      eyebrow: isPt ? "Validação" : "Validation",
      ...(requestId
        ? { detailsText: isPt ? `ID da solicitação: ${requestId}` : `Request ID: ${requestId}` }
        : {}),
      homeUrl,
      homeLabel: isPt ? "Voltar ao início" : homeLabel,
    }),
  };
};

export const buildApprovalInternalErrorHtml = (
  request: Request,
  requestId?: string,
): { html: string } | null => {
  const path = stripQuery(request.originalUrl ?? request.path);
  const group = routeFromPath(path);
  if (group === null) {
    return null;
  }
  const { homeUrl, homeLabel } = homeFooter();
  const isPt = group === "client_access";
  return {
    html: renderApprovalErrorPage({
      title: isPt ? "Erro no servidor" : "Error",
      bodyText: isPt
        ? "Ocorreu um erro inesperado. Tente novamente mais tarde."
        : env.nodeEnv === "production"
          ? "An unexpected error occurred. Please try again later."
          : "An unexpected error occurred. Please try again later.",
      lang: isPt ? "pt-BR" : "en",
      eyebrow: isPt ? "Erro" : "Error",
      ...(requestId
        ? { detailsText: isPt ? `ID da solicitação: ${requestId}` : `Request ID: ${requestId}` }
        : {}),
      homeUrl,
      homeLabel: isPt ? "Voltar ao início" : homeLabel,
    }),
  };
};
