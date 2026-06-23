/**
 * indexedDbStore.js
 * Client-side IndexedDB buffer for heartbeat events.
 * Events are appended during a session and flushed to the server at session end.
 *
 * Usage (JS Interop from Blazor):
 *   await window.indexedDbStore.openStore(sessionId);
 *   await window.indexedDbStore.appendHeartbeat(record);
 *   const events = await window.indexedDbStore.getAllHeartbeats(sessionId);
 *   await window.indexedDbStore.clearStore(sessionId);
 */

(() => {
    const DB_NAME    = 'PoSurviveHeartbeats';
    const DB_VERSION = 1;
    const STORE_NAME = 'heartbeats';

    /** @type {IDBDatabase|null} */
    let _db = null;

    function openDb() {
        return new Promise((resolve, reject) => {
            if (_db) { resolve(_db); return; }

            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { autoIncrement: true });
                    store.createIndex('bySessionId', 'sessionId', { unique: false });
                }
            };

            req.onsuccess  = (event) => { _db = event.target.result; resolve(_db); };
            req.onerror    = (event) => reject(event.target.error);
        });
    }

    /**
     * Opens (or re-uses) the IndexedDB store for the given session.
     * Must be called before appendHeartbeat or getAllHeartbeats.
     * @param {string} sessionId - GUID string
     */
    async function openStore(sessionId) {
        await openDb();
        return { sessionId, opened: true };
    }

    /**
     * Appends a heartbeat record to the IndexedDB store.
     * @param {object} record - HeartbeatEventDto-compatible plain object
     */
    async function appendHeartbeat(record) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx    = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req   = store.add(record);
            req.onsuccess = ()  => resolve(req.result);
            req.onerror   = (e) => reject(e.target.error);
        });
    }

    /**
     * Retrieves all heartbeat records for the given session, ordered by insertion.
     * @param {string} sessionId - GUID string
     * @returns {Promise<object[]>}
     */
    async function getAllHeartbeats(sessionId) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx      = db.transaction(STORE_NAME, 'readonly');
            const store   = tx.objectStore(STORE_NAME);
            const index   = store.index('bySessionId');
            const req     = index.getAll(sessionId);
            req.onsuccess = ()  => resolve(req.result);
            req.onerror   = (e) => reject(e.target.error);
        });
    }

    /**
     * Deletes all heartbeat records for the given session (called after successful server flush).
     * @param {string} sessionId - GUID string
     */
    async function clearStore(sessionId) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx      = db.transaction(STORE_NAME, 'readwrite');
            const store   = tx.objectStore(STORE_NAME);
            const index   = store.index('bySessionId');
            const req     = index.openCursor(sessionId);
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { cursor.delete(); cursor.continue(); }
                else        { resolve(); }
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    window.indexedDbStore = { openStore, appendHeartbeat, getAllHeartbeats, clearStore };
})();
