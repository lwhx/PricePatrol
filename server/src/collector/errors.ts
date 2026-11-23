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

