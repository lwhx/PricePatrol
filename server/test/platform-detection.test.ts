import { expect, it } from 'vitest';
import { createCollector, type HttpTransport } from '../src/collector/index.js';
import type { VerifiedAccount } from '../../shared/contracts.js';

const base: VerifiedAccount = {
  platform: 'taobao',
  sellerId: '777777',
  shopName: 'Fixture shop',
  cookies: [{ name: 'unb', value: 'fixture-user', domain: '.taobao.com' }],
  userAgent: 'fixture-browser',
  appKey: 'fixture-key',
};

function pageBody(shopName: string, itemId: string) {
  return JSON.stringify({
    ret: ['SUCCESS::ok'],
    data: {
      result: {
        success: true,
        data: {
          pagination: { current: 1, pageSize: 100, total: 1 },
          table: { dataSource: [{ itemId: Number(itemId), itemDesc: { desc: [{ uiType: 'link', text: shopName }] } }] },
        },
      },
    },
  });
}

/**
 * The listing endpoint answers per platform: the shop's own platform returns rows, while the
 * other platform rejects the cookie with a security challenge — exactly what the marketplace
 * does when a Tmall cookie is pointed at the Taobao management API.
 */
function crossPlatform(own: 'tmall' | 'taobao', shopName: string) {
  const seen: string[] = [];
  const transport: HttpTransport = async url => {
    const api = new URL(url).searchParams.get('api') ?? '';
    seen.push(api);
    const isOwn = api === `mtop.${own}.sell.pc.manage.async`;
    return {
      status: 200,
      headers: {},
      body: isOwn ? pageBody(shopName, '1089211436576') : JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE::需要验证', 'RGV587_ERROR::blocked'] }),
    };
  };
  return { collector: createCollector({ transport }), apis: () => seen };
}

it('reports the shop and platform actually behind the cookie instead of a bare security challenge', async () => {
  // The cookie belongs to a Tmall shop but the user imported it as Taobao.
  const { collector } = crossPlatform('tmall', '鑫泊庄园旗舰店');
  await expect(collector.verify({ ...base, platform: 'taobao' })).rejects.toMatchObject({
    code: 'PLATFORM_MISMATCH',
    message: expect.stringContaining('天猫'),
  });
});

it('does not fall back to the other platform when the chosen platform already answers', async () => {
  const { collector, apis } = crossPlatform('tmall', '鑫泊庄园旗舰店');
  // Detail parsing needs a real product page, so verification stops there — the point of this
  // test is that the accepted platform is the only one ever asked.
  await expect(collector.verify({ ...base, platform: 'tmall' })).rejects.toMatchObject({ code: 'DETAIL_INVALID' });
  expect(apis().includes('mtop.taobao.sell.pc.manage.async')).toBe(false);
});

it('keeps the security challenge when neither platform accepts the cookie', async () => {
  const transport: HttpTransport = async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE::需要验证', 'RGV587_ERROR::blocked'] }),
  });
  const collector = createCollector({ transport });
  await expect(collector.verify(base)).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
});
