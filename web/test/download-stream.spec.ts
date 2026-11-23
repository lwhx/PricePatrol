// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { downloadStream } from '../src/api/client';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('checks file availability with HEAD before starting a browser download without buffering a blob', async () => {
  const blob = vi.fn(), fetchMock = vi.fn().mockResolvedValue({ok:true,status:200,blob});
  vi.stubGlobal('fetch',fetchMock);
  const click = vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(() => {});
  await downloadStream('/export-jobs/job/download','prices.csv');
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/export-jobs/job/download',{method:'HEAD',credentials:'include'});
  expect(click).toHaveBeenCalledOnce(); expect(blob).not.toHaveBeenCalled();
});
it('shows an expired or missing file error instead of downloading the JSON error response as data', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:410}));
  const click = vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(() => {});
  await expect(downloadStream('/export-jobs/job/download','prices.csv')).rejects.toThrow('文件已丢失');
  expect(click).not.toHaveBeenCalled();
});
