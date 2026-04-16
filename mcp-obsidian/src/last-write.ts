// src/last-write.ts
let lastWriteTs: string | null = null;
export function setLastWriteTs(): void { lastWriteTs = new Date().toISOString(); }
export function getLastWriteTs(): string | null { return lastWriteTs; }
