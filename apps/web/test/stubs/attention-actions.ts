/**
 * Test stand-in for app/attention/actions (a "use server" module that writes `attention_acks`);
 * test/register.mjs maps it. Rendering never calls these: they only have to exist.
 */
export type SeenResult = { ok: boolean; message: string; inserted: string[] };

const done = async (): Promise<SeenResult> => ({ ok: true, message: "", inserted: [] });

export const markSeenAction = (_keys: string[]) => done();
export const undoSeenAction = (_keys: string[]) => done();
export const unseeAction = (_key: string) => done();
