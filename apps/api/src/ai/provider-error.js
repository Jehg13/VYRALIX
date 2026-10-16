export class ProviderError extends Error {
  constructor(code, message, { retryable = false, retryAfterSeconds = null, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

export function safeProviderError(error) {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return { code: 'provider_error', message: 'El proveedor no pudo completar la solicitud.', retryable: false, retryAfterSeconds: null };
}
