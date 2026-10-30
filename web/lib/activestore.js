/**
 * Which storage the whole app is using, in one place.
 *
 * WHY THIS EXISTS
 * ---------------
 * `backend.js` made its `store` a mutable binding so it could point at
 * either IndexedDB or the shared workspace. That worked for backend.js and
 * for nothing else, because `pipeline.js` -- which is where ingest actually
 * writes scans, masks and case records -- had its own
 * `import * as store from './store.js'`. A module namespace import is
 * resolved once and cannot be swapped, so every scan segmented while a
 * shared workspace was open was written to the local browser instead.
 *
 * The symptom was quiet and convincing: the case appeared in the worklist
 * (that comes from in-memory STATE), reported success, and was simply not
 * there for anyone else, or after a reload. Nothing errored.
 *
 * So the selection lives here, in a module both of them import, and the
 * functions below delegate to whichever is active at CALL time rather than
 * at import time. Any future module that needs storage should import this,
 * never store.js directly -- that is the rule the bug came from breaking.
 */

import * as localStore from './store.js';

let active = localStore;

export function setActiveStore(s) { active = s; }
export function activeStore() { return active; }
export function isLocal() { return active === localStore; }
export { localStore };

/* Delegating wrappers. Each resolves `active` when called, which is the
   whole point -- a bare re-export would bind to whatever was active when
   this module first loaded and reintroduce exactly the bug above. */
export const allCases = (...a) => active.allCases(...a);
export const putCase = (...a) => active.putCase(...a);
export const putCases = (...a) => active.putCases(...a);
export const deleteCase = (...a) => active.deleteCase(...a);
export const clearAll = (...a) => active.clearAll(...a);
export const putFile = (...a) => active.putFile(...a);
export const getFile = (...a) => active.getFile(...a);
export const putFiles = (...a) => active.putFiles(...a);
export const requestPersistence = (...a) => active.requestPersistence(...a);
export const usage = (...a) => active.usage(...a);
export const storagePolicy = (...a) => active.storagePolicy(...a);

/* Preferences and one-time markers are per-device, not per-workspace: a
   reviewer changing their own mask opacity should not change it for the
   whole lab. These always go to the browser. */
export const getKV = localStore.getKV;
export const setKV = localStore.setKV;
