export class SessionRegistry {
    sessions = new Map();
    idleTtlMs;
    maxSessions;
    now;
    onEvent;
    counters = {
        created: 0,
        closed: 0,
        expired: 0,
        evicted: 0,
    };
    constructor(options) {
        if (options.idleTtlMs <= 0)
            throw new Error('idleTtlMs must be greater than zero');
        if (options.maxSessions <= 0)
            throw new Error('maxSessions must be greater than zero');
        this.idleTtlMs = options.idleTtlMs;
        this.maxSessions = options.maxSessions;
        this.now = options.now ?? Date.now;
        this.onEvent = options.onEvent;
    }
    get size() {
        return this.sessions.size;
    }
    get capacity() {
        return this.maxSessions;
    }
    get stats() {
        return { ...this.counters };
    }
    has(id) {
        return this.sessions.has(id);
    }
    get(id) {
        const session = this.sessions.get(id);
        if (!session)
            return undefined;
        return { transport: session.transport, server: session.server };
    }
    touch(id) {
        const session = this.sessions.get(id);
        if (!session)
            return false;
        session.lastActivityAt = this.now();
        return true;
    }
    startActivity(id) {
        const session = this.sessions.get(id);
        if (!session)
            return false;
        session.activeRequests += 1;
        session.lastActivityAt = this.now();
        return true;
    }
    endActivity(id) {
        const session = this.sessions.get(id);
        if (!session)
            return false;
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        session.lastActivityAt = this.now();
        return true;
    }
    async add(id, resources) {
        const detached = [];
        if (this.sessions.has(id)) {
            const replaced = this.detach(id, 'explicit');
            if (replaced)
                detached.push(replaced);
        }
        while (this.sessions.size >= this.maxSessions) {
            const oldestId = this.findLeastRecentlyActiveId();
            if (!oldestId)
                break;
            const session = this.detach(oldestId, 'evicted');
            if (session)
                detached.push(session);
        }
        const timestamp = this.now();
        this.sessions.set(id, {
            ...resources,
            createdAt: timestamp,
            lastActivityAt: timestamp,
            activeRequests: 0,
        });
        this.counters.created += 1;
        this.onEvent?.({ type: 'created', sessionId: id, activeSessions: this.sessions.size });
        await Promise.all(detached.map((session) => this.closeResources(session)));
    }
    async sweepExpired() {
        const deadline = this.now() - this.idleTtlMs;
        const expiredIds = [...this.sessions.entries()]
            .filter(([, session]) => session.activeRequests === 0 && session.lastActivityAt <= deadline)
            .map(([id]) => id);
        await Promise.all(expiredIds.map((id) => this.close(id, 'expired')));
        return expiredIds.length;
    }
    async close(id, reason) {
        const session = this.detach(id, reason);
        if (!session)
            return false;
        if (reason !== 'transport')
            await this.closeResources(session);
        return true;
    }
    closeAfterTransport(id, reason = 'transport') {
        return this.detach(id, reason) !== undefined;
    }
    async closeAll(reason) {
        const ids = [...this.sessions.keys()];
        await Promise.all(ids.map((id) => this.close(id, reason)));
        return ids.length;
    }
    findLeastRecentlyActiveId() {
        let oldestIdle;
        let oldestActive;
        for (const [id, session] of this.sessions) {
            const candidate = { id, lastActivityAt: session.lastActivityAt };
            if (session.activeRequests === 0) {
                if (!oldestIdle || session.lastActivityAt < oldestIdle.lastActivityAt) {
                    oldestIdle = candidate;
                }
            }
            else if (!oldestActive || session.lastActivityAt < oldestActive.lastActivityAt) {
                oldestActive = candidate;
            }
        }
        // Preserve active streams whenever possible. If every session is active, retain
        // the hard capacity bound and evict the oldest stream to protect process memory.
        return oldestIdle?.id ?? oldestActive?.id;
    }
    detach(id, reason) {
        const session = this.sessions.get(id);
        if (!session)
            return undefined;
        this.sessions.delete(id);
        this.counters.closed += 1;
        if (reason === 'expired')
            this.counters.expired += 1;
        if (reason === 'evicted')
            this.counters.evicted += 1;
        this.onEvent?.({
            type: 'closed',
            sessionId: id,
            activeSessions: this.sessions.size,
            reason,
        });
        return session;
    }
    async closeResources(session) {
        await Promise.allSettled([
            Promise.resolve().then(() => session.server.close()),
        ]);
    }
}
