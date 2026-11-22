import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sendServerChan, serverChanEndpoint} from '../src/integrations/serverchan.js';

const SCT = 'SCT123localTestOnly';
const SC3 = 'sctp123tlocalTestOnly';
const message = {title: '价格预警', description: '测试店铺：2 商品 / 3 SKU\n\n**低于8.5折**', short: '3 SKU'};
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
});

async function localTransport(payload: unknown, status = 200) {
  const requests: {url: string; method: string; type: string; body: string; redirect?: RequestRedirect}[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({url: request.url!, method: request.method!, type: String(request.headers['content-type']), body: Buffer.concat(chunks).toString()});
    response.writeHead(status, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(payload));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const result = await fetch(`${origin}${url.pathname}`, init);
    requests.at(-1)!.redirect = init?.redirect;
    return result;
  };
  return {transport, requests};
}

describe('Server酱端点及真实请求形状（仅发往本机HTTP）', () => {
  it.each([
    [SCT, 'https://sctapi.ftqq.com/SCT123localTestOnly.send'],
    [SC3, 'https://123.push.ft07.com/send/sctp123tlocalTestOnly.send'],
  ])('识别两种官方SendKey格式：%s', (key, endpoint) => {
    expect(serverChanEndpoint(key)).toBe(endpoint);
  });

  it.each([SCT, SC3])('POST title/desp并仅在数字code为0时受理：%s', async key => {
    const {transport, requests} = await localTransport({code: 0, message: 'SUCCESS', data: {pushid: '42', readkey: 'private-read-key'}});
    const result = await sendServerChan(key, message, {fetch: transport});
    expect(result).toEqual({accepted: true, requestId: '42'});
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe(key === SCT ? '/SCT123localTestOnly.send' : '/send/sctp123tlocalTestOnly.send');
    expect(requests[0].type).toMatch(/^application\/x-www-form-urlencoded/);
    expect(Object.fromEntries(new URLSearchParams(requests[0].body))).toEqual({title: message.title, desp: message.description, short: message.short});
    expect(JSON.stringify(result)).not.toContain('private-read-key');
  });

  it.each(['', ' ', 'abc', 'SCT', 'SCTbad/key', 'SCTa?secret', 'SCTa\r\n', 'sctplocal', 'sctp123t', 'sctp123tbad@host', 'SCT' + 'a'.repeat(300)])('拒绝畸形key，不回显：%j', async key => {
    expect(() => serverChanEndpoint(key)).toThrow(/SendKey/);
    const transport = vi.fn<typeof fetch>();
    await expect(sendServerChan(key, message, {fetch: transport})).rejects.toThrow(/SendKey/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('正文/标题/摘要有限长度，标题去换行且不会拆坏Unicode字符', async () => {
    const {transport, requests} = await localTransport({code: 0});
    await sendServerChan(SCT, {title: '商品\n\r' + '🍵'.repeat(100), description: '茶'.repeat(40000), short: '茶'.repeat(300)}, {fetch: transport});
    const fields = Object.fromEntries(new URLSearchParams(requests[0].body));
    expect(fields.title).not.toMatch(/[\r\n\uFFFD]/);
    expect(Array.from(fields.title).length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(fields.desp)).toBeLessThanOrEqual(30000);
    expect(Array.from(fields.short).length).toBeLessThanOrEqual(64);
    expect(fields.desp).not.toContain('\uFFFD');
  });

  it('空标题在请求前报错', async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(sendServerChan(SCT, {title: '\n ', description: ''}, {fetch: transport})).rejects.toThrow(/标题/);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([{code: 40001, message: `secret=${SCT}`}, {code: '0'}, {errcode: 0}, {}, null, []])('HTTP 200也不能把失败/未知业务码当成功：%j', async payload => {
    const {transport} = await localTransport(payload);
    const error = await sendServerChan(SCT, message, {fetch: transport}).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/Server酱/);
    expect(String(error)).not.toContain(SCT);
    expect(error.cause).toBeUndefined();
  });

  it('HTTP错误不传播原始响应正文', async () => {
    const {transport} = await localTransport({code: 0, message: `https://sctapi.ftqq.com/${SCT}.send`}, 503);
    await expect(sendServerChan(SCT, message, {fetch: transport})).rejects.toThrow(/HTTP 503/);
  });

  it('网络异常丢弃URL、key和cause', async () => {
    const transport: typeof fetch = async () => { throw new Error(`POST https://sctapi.ftqq.com/${SCT}.send`, {cause: new Error(SCT)}); };
    const error = await sendServerChan(SCT, message, {fetch: transport}).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/SCT123|https:|ftqq/);
    expect(error.cause).toBeUndefined();
  });

  it('无效JSON只返回通用错误', async () => {
    const transport: typeof fetch = async () => new Response(`not-json-${SCT}`);
    await expect(sendServerChan(SCT, message, {fetch: transport})).rejects.toThrow(/响应/);
  });

  it('慢请求会在短超时后中止', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null | undefined;
    const transport: typeof fetch = async (_input, init) => {
      observedSignal = init?.signal;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(SCT)), {once: true}));
    };
    const result = sendServerChan(SCT, message, {fetch: transport}).catch(error => error);
    await vi.advanceTimersByTimeAsync(6000);
    expect(observedSignal?.aborted).toBe(true);
    const error = await result;
    expect(String(error)).toMatch(/超时/);
    expect(error.cause).toBeUndefined();
  });
});
