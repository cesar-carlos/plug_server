import type { Agent } from "../../domain/entities/agent.entity";

const norm = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : value;

/** Compares catalog-facing profile fields only (ignores version, timestamps, login metadata, status). */
export const agentsProfileCatalogContentEqual = (a: Agent, b: Agent): boolean =>
  a.name === b.name &&
  norm(a.tradeName) === norm(b.tradeName) &&
  norm(a.document) === norm(b.document) &&
  a.documentType === b.documentType &&
  norm(a.phone) === norm(b.phone) &&
  norm(a.mobile) === norm(b.mobile) &&
  norm(a.email) === norm(b.email) &&
  norm(a.street) === norm(b.street) &&
  norm(a.number) === norm(b.number) &&
  norm(a.district) === norm(b.district) &&
  norm(a.postalCode) === norm(b.postalCode) &&
  norm(a.city) === norm(b.city) &&
  norm(a.state) === norm(b.state) &&
  norm(a.notes) === norm(b.notes);
