export type IncidentEvent = 'first' | 'continuing' | 'worsened' | 'recovered';
export type IncidentState = 'pending' | 'confirmed' | 'resolved';
export type IncidentStatus = 'active' | 'recovered' | 'superseded';
export interface NotificationPolicy { cooldownHours: number; notifyRecovery: boolean }
export interface Incident {
  id: string;
  identity: string;
  ruleFingerprint: string;
  alertTaskId: string;
  shopId: string;
  shopName: string;
  productId: string;
  skuId: string;
  title: string;
  specs: string;
  status: IncidentStatus;
  state: IncidentState;
  note: string;
  resolvedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  firstCollectionRunId: string;
  lastCollectionRunId: string;
  lastAlertRunId: string;
  lastEvent: IncidentEvent;
}
