// Sign-in codes by email.
//
// No secret lives in this file. The sender is chosen from deployment settings:
//   1. Resend         RESEND_API_KEY + OTP_EMAIL_FROM ("USOPGRID <login@yourdomain.com>")
//   2. HTTP relay     OTP_EMAIL_RELAY_URL + OTP_EMAIL_API_KEY (the template's relay
//                     contract: POST {to, otp, appName} with header x-api-key)
// With neither configured, sign-in by email fails closed with a clear error.
//
// The relay key that used to be hard-coded here was published in the template's
// git history: treat it as compromised and never reuse it.
import { Email } from "@convex-dev/auth/providers/Email";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

const APP_NAME = () => process.env.VLY_APP_NAME || "USOPGRID";
const TIMEOUT_MS = 10_000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function sendOtpEmail(email: string, token: string): Promise<void> {
  const app = APP_NAME();
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.OTP_EMAIL_FROM;
  if (resendKey && from) {
    const r = await post(
      "https://api.resend.com/emails",
      { Authorization: `Bearer ${resendKey}` },
      {
        from,
        to: [email],
        subject: `${token} is your ${app} sign-in code`,
        text: `Your ${app} sign-in code is ${token}. It expires in 15 minutes.\n\nIf you did not try to sign in, ignore this email; nobody can sign in without the code.`,
        html: `<p>Your ${escapeHtml(app)} sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${token}</p><p>It expires in 15 minutes. If you did not try to sign in, ignore this email.</p>`,
      },
    );
    // Never echo provider responses or request config: they can contain credentials.
    if (!r.ok) throw new Error(`Sign-in email could not be sent (email service returned HTTP ${r.status}).`);
    return;
  }
  const relayUrl = process.env.OTP_EMAIL_RELAY_URL;
  const relayKey = process.env.OTP_EMAIL_API_KEY;
  if (relayUrl && relayKey) {
    if (!relayUrl.startsWith("https://")) throw new Error("OTP_EMAIL_RELAY_URL must use https.");
    const r = await post(relayUrl, { "x-api-key": relayKey }, { to: email, otp: token, appName: app });
    if (!r.ok) throw new Error(`Sign-in email could not be sent (relay returned HTTP ${r.status}).`);
    return;
  }
  throw new Error("Email sign-in is not configured: set RESEND_API_KEY and OTP_EMAIL_FROM (or OTP_EMAIL_RELAY_URL and OTP_EMAIL_API_KEY).");
}

export const emailOtp = Email({
  id: "email-otp",
  maxAge: 60 * 15, // 15 minutes
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
      },
    };
    return generateRandomString(random, "0123456789", 8);
  },
  async sendVerificationRequest({ identifier: email, token }: { identifier: string; token: string }) {
    try {
      await sendOtpEmail(email, token);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Sign-in email could not be sent.");
    }
  },
});
