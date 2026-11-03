/**
 * Test stand-in for app/schedules/actions (a "use server" module that writes the database);
 * test/register.mjs maps it. Rendering never calls these: they only have to exist.
 */
export type ActionResult = { ok: boolean; message: string };

const done = async (): Promise<ActionResult> => ({ ok: true, message: "" });

export const requestScheduleRunAction = (_id: string) => done();
export const setScheduleEnabledAction = (_id: string, _enabled: boolean) => done();
export const updateScheduleWhenAction = (_id: string, _cron: string, _tz: string) => done();
export const deleteScheduleAction = (_id: string) => done();
