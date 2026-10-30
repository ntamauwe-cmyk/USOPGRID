// MFA enrolment and recovery codes end to end.
import { describe, expect, test } from "vitest";
import { api as fns } from "../convex/_generated/api";
import { totpAt } from "../convex/lib/crypto";
import { setup } from "./setup";

describe("multi-factor authentication", () => {
  test("enrolling returns 8 recovery codes; new codes need a fresh authenticator code and replace the old set", async () => {
    const { t, owner } = await setup();
    const me = t.withIdentity({ subject: `${owner}|s1` });
    const { secret } = await me.action(fns.security.beginEnrollment, {});
    const now = Math.floor(Date.now() / 1000);

    const first = await me.action(fns.security.verifyCode, { code: await totpAt(secret, now) });
    expect(first.recoveryCodes).toHaveLength(8);
    expect((await me.query(fns.security.status, {})).mfaEnabled).toBe(true);

    await expect(me.action(fns.security.regenerateRecoveryCodes, { code: "000000" })).rejects.toThrow(/Invalid code/);
    // The same time step cannot be replayed.
    await expect(me.action(fns.security.regenerateRecoveryCodes, { code: await totpAt(secret, now) })).rejects.toThrow(/already used/);

    const next = await me.action(fns.security.regenerateRecoveryCodes, { code: await totpAt(secret, now + 30) });
    expect(next.recoveryCodes).toHaveLength(8);
    expect(next.recoveryCodes).not.toEqual(first.recoveryCodes);

    // Old codes stop working; new ones work once.
    await expect(me.action(fns.security.useRecoveryCode, { code: first.recoveryCodes![0] })).rejects.toThrow(/Invalid recovery code/);
    await me.action(fns.security.useRecoveryCode, { code: next.recoveryCodes[0] });
    expect((await me.query(fns.security.status, {})).recoveryCodesRemaining).toBe(7);
    await expect(me.action(fns.security.useRecoveryCode, { code: next.recoveryCodes[0] })).rejects.toThrow(/Invalid recovery code/);
  });

  test("new recovery codes cannot be requested without MFA on", async () => {
    const { t, owner } = await setup();
    const me = t.withIdentity({ subject: `${owner}|s1` });
    await expect(me.action(fns.security.regenerateRecoveryCodes, { code: "123456" })).rejects.toThrow(/Turn on MFA first/);
  });
});
