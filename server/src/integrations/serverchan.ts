import type {NotificationMessage} from '../../../shared/contracts.js';

const TIMEOUT_MS = 5000;
const MAX_DESCRIPTION_BYTES = 30_000;
const MAX_RESPONSE_BYTES = 65_536;

/** Official current routing: https://sct.ftqq.com/docs/integrations/python/ */
export function serverChanEndpoint(sendKey: string): string {
  if (typeof sendKey !== 'string' || sendKey.length > 256) throw new Error('Server酱 SendKey 格式无效');
  if (/^SCT[A-Za-z0-9]+$/.test(sendKey)) return `https://sctapi.ftqq.com/${sendKey}.send`;
  const sc3 = /^sctp(\d{1,20})t[A-Za-z0-9]+$/.exec(sendKey);
  if (sc3) return `https://${sc3[1]}.push.ft07.com/send/${sendKey}.send`;
  throw new Error('Server酱 SendKey 格式无效，请填写 SCT 或 sctp 开头的完整密钥');
}

function boundedText(text: string, maxCharacters: number, maxBytes = Infinity): string {
  let result = '';
  let characters = 0;
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (characters >= maxCharacters || bytes + size > maxBytes) break;
    result += character;
    characters++;
    bytes += size;
  }
  return result;
}

function messageBody(message: NotificationMessage): URLSearchParams {
  if (!message || typeof message.title !== 'string' || typeof message.description !== 'string' ||
      (message.short !== undefined && typeof message.short !== 'string')) throw new Error('Server酱通知标题或正文格式无效');
  const title = boundedText(message.title.replace(/[\r\n\u2028\u2029]+/g, ' ').trim(), 32);
  if (!title) throw new Error('Server酱通知标题不能为空');
  const body = new URLSearchParams({title, desp: boundedText(message.description, MAX_DESCRIPTION_BYTES, MAX_DESCRIPTION_BYTES)});
  if (message.short !== undefined) body.set('short', boundedText(message.short, 64));
  return body;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function acceptedResult(payload: unknown, sendKey: string): {accepted: boolean; requestId?: string} {
  // Official SDK and docs specify numeric code === 0 for BOTH SCT and SC3.
  if (!payload || typeof payload !== 'object' || !('code' in payload) || payload.code !== 0) {
    throw new Error('Server酱未受理通知，请检查密钥、通道及发送额度');
  }
  const data = 'data' in payload ? payload.data : undefined;
  const pushid = data && typeof data === 'object' && 'pushid' in data ? data.pushid : undefined;
  const requestId = typeof pushid === 'number' || typeof pushid === 'string' ? String(pushid) : '';
  if (/^[A-Za-z0-9_-]{1,128}$/.test(requestId) && !requestId.includes(sendKey)) return {accepted: true, requestId};
  return {accepted: true};
}

export async function sendServerChan(
  sendKey: string,
  message: NotificationMessage,
  options: {fetch?: typeof fetch} = {},
): Promise<{accepted: boolean; requestId?: string}> {
  const endpoint = serverChanEndpoint(sendKey);
  const body = messageBody(message);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
        body,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // Native fetch errors/cause may contain the full credential-bearing URL.
      throw new Error(controller.signal.aborted ? 'Server酱请求超时，请稍后重试' : 'Server酱网络请求失败，请检查网络后重试');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Server酱请求失败（HTTP ${response.status}）`);
    }
    let payload: unknown;
    try {
      payload = await responseJson(response);
    } catch {
      throw new Error(controller.signal.aborted ? 'Server酱请求超时，请稍后重试' : 'Server酱响应无效，请稍后重试');
    }
    return acceptedResult(payload, sendKey);
  } finally {
    clearTimeout(timer);
  }
}
