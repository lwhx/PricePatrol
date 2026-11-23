const invalidCredentialCodes = new Set([
    'AUTH', 'LOGIN', 'SESSION', 'PERMISSION',
    'AUTH_REQUIRED', 'COOKIE_INVALID', 'VERIFICATION_REQUIRED', 'IDENTITY_CHANGED', 'BACKEND_AUTH_REQUIRED',
    'LOGIN_REQUIRED', 'SESSION_EXPIRED', 'FAIL_SYS_SESSION_EXPIRED', 'NO_PERMISSION', 'PERMISSION_DENIED',
]);

export function isInvalidCredentialCode(code: unknown): boolean {
    return typeof code === 'string' && invalidCredentialCodes.has(code);
}

export class CollectorError extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = 'CollectorError'; }
}
export function checkAbort(signal: AbortSignal): void {
    if (signal.aborted) {
        if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')
            throw new CollectorError('TIMEOUT', '请求超时，请稍后重试');
        throw new CollectorError('ABORTED', '采集已停止');
    }
}

