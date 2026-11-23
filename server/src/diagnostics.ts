import type { Writable } from 'node:stream';
import { errorCodes, type FastifyBaseLogger, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from './api-context.js';
import { BrowserLoginError } from './integrations/browser-login.js';

const backgroundEvents = [
  'collection_failed', 'collection_auth_required', 'alert_dispatch_failed',
  'alert_evaluation_failed', 'notification_failed', 'schedule_storage_failed',
  'schedule_invalid', 'schedule_enqueue_failed',
] as const;
type BackgroundEvent = typeof backgroundEvents[number];
type Identifiers = { runId?: string; evaluationId?: string; taskId?: string };
export type DiagnosticReporter = (event: BackgroundEvent, identifiers?: Identifiers) => void;

const allowedEvents = new Set<string>(['request_completed', 'request_failed', ...backgroundEvents]);
const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uuid = new RegExp(`^${uuidPattern}$`, 'i');
const evaluation = new RegExp(`^${uuidPattern}:${uuidPattern}$`, 'i');

export function diagnosticLogger(stream?: Writable): FastifyServerOptions['logger'] {
  if (!stream && process.env.NODE_ENV !== 'production') return false;
  return {
    stream,
    hooks: {
      logMethod(args, method) {
        const record = args[0];
        // Only explicit diagnostic events reach the sink, including during Fastify's own error paths.
        if (record && typeof record === 'object' && 'event' in record && allowedEvents.has(String(record.event))) {
          Reflect.apply(method, this, [record]);
        }
      },
    },
  };
}

export function backgroundDiagnostics(logger: FastifyBaseLogger): DiagnosticReporter {
  return (event, ids = {}) => logger.warn({
    event,
    runId: ids.runId && uuid.test(ids.runId) ? ids.runId : undefined,
    evaluationId: ids.evaluationId && evaluation.test(ids.evaluationId) ? ids.evaluationId : undefined,
    taskId: ids.taskId && uuid.test(ids.taskId) ? ids.taskId : undefined,
  });
}

function requestDetails(request: FastifyRequest) {
  const route = request.routeOptions.url || null;
  const id = (request.params as { id?: unknown } | undefined)?.id;
  const runId = route?.startsWith('/api/runs/:id') && typeof id === 'string' && uuid.test(id) ? id : undefined;
  const evaluationId = route?.startsWith('/api/alert-runs/:id') && typeof id === 'string' && evaluation.test(id) ? id : undefined;
  return { route, method: request.method, runId: runId || evaluationId?.split(':')[0], evaluationId };
}

function classifyHttpError(error: unknown) {
  if (error instanceof ZodError) {
    const message = error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；');
    return { statusCode: 400, message, errorKind: 'invalid_input' };
  }
  if (error instanceof HttpError || error instanceof BrowserLoginError) {
    return { statusCode: error.statusCode, message: error.message, errorKind: 'expected' };
  }
  if (error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE) {
    return { statusCode: 413, message: '请求内容过大', errorKind: 'invalid_input' };
  }
  if (error instanceof errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE) {
    return { statusCode: 415, message: '不支持的请求内容类型', errorKind: 'invalid_input' };
  }
  if (error instanceof errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY || error instanceof errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
      error instanceof errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH || error instanceof errorCodes.FST_ERR_VALIDATION) {
    return { statusCode: 400, message: '请求内容格式无效', errorKind: 'invalid_input' };
  }
  return { statusCode: 500, message: '服务内部错误，请稍后重试', errorKind: 'internal' };
}

export function registerDiagnostics(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ event: 'request_completed', ...requestDetails(request), statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) });
  });
  app.setErrorHandler((error, request, reply) => {
    const { statusCode, message, errorKind } = classifyHttpError(error);
    if (statusCode >= 500) request.log.error({ event: 'request_failed', ...requestDetails(request), statusCode, errorKind });
    return reply.code(statusCode).send({ error: message });
  });
}
