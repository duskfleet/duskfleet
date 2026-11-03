/**
 * Test stand-in for app/settings/actions (a "use server" module that writes duskfleet.yaml);
 * test/register.mjs maps it. Rendering never calls these: they only have to exist.
 */
export interface SettingsResult {
  ok: boolean;
  message: string;
  savedAt?: string;
}

const done = async (): Promise<SettingsResult> => ({ ok: true, message: "" });

export const saveSettingsAction = (_changes: Array<{ key: string; value: unknown }>) => done();
export const setSchedulerEnabledAction = (_enabled: boolean) => done();
