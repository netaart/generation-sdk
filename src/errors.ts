export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

export class GenerationConfigError extends GenerationError {
  constructor(message: string) {
    super(message);
    this.name = "GenerationConfigError";
  }
}

export class GenerationValidationError extends GenerationError {
  constructor(message: string) {
    super(message);
    this.name = "GenerationValidationError";
  }
}

/** A reference media file could not be read for a reason outside the request: network failure, timeout, or a 5xx/408/429 reply. */
export class GenerationMediaReadError extends GenerationError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GenerationMediaReadError";
    this.cause = cause;
  }

  declare cause: unknown;
}

export class GenerationUnsupportedAdapterError extends GenerationError {
  constructor(adapterType: string) {
    super(`Unsupported generation adapter: ${adapterType}`);
    this.name = "GenerationUnsupportedAdapterError";
  }
}

export class GenerationProviderError extends GenerationError {
  readonly status: number | undefined;
  readonly body: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message = "Generation provider request failed",
    options?: { status?: number; body?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "GenerationProviderError";
    this.status = options?.status;
    this.body = options?.body;
    this.details = options?.details;
  }
}

export type GenerationTransportErrorDetails = {
  method: string;
  host?: string;
  path: string;
  elapsedMs: number;
  causeName?: string;
  causeCode?: string;
  causeSyscall?: string;
  causeAddress?: string;
  causePort?: string | number;
};

export class GenerationTransportError extends GenerationProviderError {
  declare readonly details: GenerationTransportErrorDetails;

  constructor(details: GenerationTransportErrorDetails, cause: unknown) {
    super(transportErrorMessage(details), { details });
    this.name = "GenerationTransportError";
    this.cause = cause;
  }

  declare cause: unknown;
}

export class GenerationTimeoutError extends GenerationProviderError {
  constructor(message = "Generation request timed out", details?: Record<string, unknown>) {
    super(message, details ? { details } : undefined);
    this.name = "GenerationTimeoutError";
  }
}

function transportErrorMessage(details: GenerationTransportErrorDetails): string {
  return [
    "Generation transport failed",
    `method=${details.method}`,
    details.host ? `host=${details.host}` : undefined,
    `path=${details.path}`,
    `elapsed_ms=${details.elapsedMs}`,
    details.causeCode ? `cause_code=${details.causeCode}` : undefined,
    details.causeName ? `cause_name=${details.causeName}` : undefined,
    details.causeSyscall ? `cause_syscall=${details.causeSyscall}` : undefined,
    details.causeAddress ? `cause_address=${details.causeAddress}` : undefined,
    details.causePort !== undefined ? `cause_port=${details.causePort}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}
