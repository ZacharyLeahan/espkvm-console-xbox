// SPDX-License-Identifier: Apache-2.0
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decodeControllers, controllerLabel, type ControllerStatus } from '../src/input/controllers';
const rows = (): ControllerStatus[] => Array.from({ length: 4 }, (_, i) => ({ player: i+1, configured: true, seen: true, connection: 2, ip: '192.168.1.242', held: '-', beaconAgeMs: 50, diagnosticAgeMs: 100, activityAgeMs: -1, completionAgeMs: 100, sent: 10, sendErrors: 0 }));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
test('older receivers may omit USB completion counters', () => { assert.deepEqual(decodeControllers(encode(rows())), rows()); });
test('unknown transport never displays cached green as current', () => { assert.equal(controllerLabel(rows()[0], false), 'Status unavailable'); });
test('stale discovery is distinct from USB readiness', () => { const r=rows()[0];r.beaconAgeMs=6000;assert.equal(controllerLabel(r,true),'Xbox USB configured');r.connection=3;assert.equal(controllerLabel(r,true),'Status stale'); });
test('reject malformed, duplicate-player and unbounded status packets', () => {
 assert.equal(decodeControllers(new TextEncoder().encode('{')), null);
 const duplicate=rows();duplicate[3].player=1;assert.equal(decodeControllers(encode(duplicate)),null);
 const invalid=rows();invalid[0].connection=7;assert.equal(decodeControllers(encode(invalid)),null);
 assert.equal(decodeControllers(new Uint8Array(8193)),null);
 assert.equal(decodeControllers(encode(rows().slice(1))),null);
});
