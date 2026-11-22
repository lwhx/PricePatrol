export class CollectorError extends Error {
    constructor(public readonly code: string, message: string) { super(message); this.name = 'CollectorError'; }
}
export function checkAbort(signal: AbortSignal): void {
    if (signal.aborted)
        throw new CollectorError('ABORTED', '采集已停止');
}

