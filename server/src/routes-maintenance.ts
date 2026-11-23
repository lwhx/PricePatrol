import { z } from 'zod';
import type { ApiContext } from './api-context.js';
import type { MaintenanceService } from './maintenance.js';

export function registerMaintenance({ app }: Pick<ApiContext, 'app'>, maintenance: MaintenanceService): void {
  app.get('/api/maintenance/settings', async () => maintenance.getSettings());
  app.put('/api/maintenance/settings', async request =>
    maintenance.updateSettings(z.record(z.string(), z.unknown()).parse(request.body)));
  app.get('/api/maintenance/status', async () => maintenance.status());
  app.post('/api/maintenance/run', async (request, reply) => {
    const { kind } = z.strictObject({ kind: z.enum(['backup', 'all']) }).parse(request.body);
    maintenance.kick(kind);
    return reply.code(202).send({ accepted: true });
  });
  app.post('/api/maintenance/cleanup/preview', async request => {
    const { before } = z.strictObject({ before: z.iso.datetime({ offset: true }).optional() }).parse(request.body ?? {});
    return maintenance.preview(before);
  });
}
