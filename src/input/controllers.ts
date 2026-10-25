// SPDX-License-Identifier: Apache-2.0
export interface ControllerStatus {
  player: number; configured: boolean; seen: boolean; connection: number;
  ip: string; held: string; beaconAgeMs: number; diagnosticAgeMs: number;
  activityAgeMs: number; completionAgeMs: number; sent: number; sendErrors: number;
  submitted?: number; consumed?: number;
}
export function decodeControllers(bytes: Uint8Array): ControllerStatus[] | null {
  if (bytes.length > 8192) return null;
  try {
    const rows: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(rows) || rows.length !== 4) return null;
    const numeric = ['beaconAgeMs', 'diagnosticAgeMs', 'activityAgeMs', 'completionAgeMs', 'sent', 'sendErrors'] as const;
    if (!rows.every((r, i) => r && r.player === i + 1 && typeof r.configured === 'boolean' &&
      typeof r.seen === 'boolean' && Number.isInteger(r.connection) && r.connection >= 0 && r.connection <= 3 &&
      typeof r.ip === 'string' && r.ip.length <= 15 && typeof r.held === 'string' && r.held.length <= 47 &&
      numeric.every(k => typeof r[k] === 'number' && Number.isFinite(r[k])) &&
      ['submitted', 'consumed'].every(k => r[k] === undefined || (Number.isInteger(r[k]) && r[k] >= 0)))) return null;
    return rows as ControllerStatus[];
  } catch { return null; }
}
export function controllerLabel(row: ControllerStatus, known: boolean): string {
  if (!known) return 'Status unavailable';
  if (!row.configured) return 'Unpaired';
  return ['Not seen', 'Wi-Fi / USB waiting', 'Xbox USB configured', 'Status stale'][row.connection] ?? 'Status unavailable';
}
