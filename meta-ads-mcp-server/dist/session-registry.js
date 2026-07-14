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
    async add(id, resources) {
        if (this.sessions.has(id)) {
            await this.close(id, 'transport');
        }
        while (this.sessions.size >= this.maxSessions) {
            const oldestId = this.findLeastRecentlyActiveId();
            if (!oldestId)
                break;
            await this.close(oldestId, 'evicted');
        }
        const timestamp = this.now();
        this.sessions.set(id, {
            ...resources,
            createdAt: timestamp,
            lastActivityAt: timestamp,
        });
        this.counters.created += 1;
        this.onEvent?.({ type: 'created', sessionId: id, activeSessions: this.sessions.size });
    }
    async sweepExpired() {
        const deadline = this.now() - this.idleTtlMs;
        const expiredIds = [...this.sessions.entries()]
            .filter(([, session]) => session.lastActivityAt <= deadline)
            .map(([id]) => id);
        await Promise.all(expiredIds.map((id) => this.close(id, 'expired')));
        return expiredIds.length;
    }
    async close(id, reason) {
        const session = this.sessions.get(id);
        if (!session)
            return false;
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
        await Promise.allSettled([
            Promise.resolve(session.transport.close()),
            Promise.resolve(session.server.close()),
        ]);
        return true;
    }
    async closeAll(reason) {
        const ids = [...this.sessions.keys()];
        await Promise.all(ids.map((id) => this.close(id, reason)));
        return ids.length;
    }
    findLeastRecentlyActiveId() {
        let oldest;
        for (const [id, session] of this.sessions) {
            if (!oldest || session.lastActivityAt < oldest.lastActivityAt) {
                oldest = { id, lastActivityAt: session.lastActivityAt };
            }
        }
        return oldest?.id;
    }
}
