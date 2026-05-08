export interface HttpErrorResponseBody {
  readonly success: false;
  readonly message: string;
  readonly code: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly details?: unknown;
  readonly issues?: ReadonlyArray<{ readonly field: string; readonly message: string }>;
  readonly requestId?: string;
}

export const buildHttpErrorResponseBody = (input: {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string | undefined;
  readonly details?: unknown | undefined;
  readonly exposeDetails?: boolean | undefined;
  readonly issues?: ReadonlyArray<{ readonly field: string; readonly message: string }> | undefined;
}): HttpErrorResponseBody => {
  const exposedDetails = input.exposeDetails === true ? input.details : undefined;
  const validationDetails = input.issues !== undefined ? { issues: input.issues } : undefined;
  const errorDetails = validationDetails ?? exposedDetails;

  return {
    success: false,
    message: input.message,
    code: input.code,
    error: {
      code: input.code,
      message: input.message,
      ...(errorDetails !== undefined ? { details: errorDetails } : {}),
    },
    ...(exposedDetails !== undefined ? { details: exposedDetails } : {}),
    ...(input.issues !== undefined ? { issues: input.issues } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  };
};
