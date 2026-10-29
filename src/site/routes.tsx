// Public-site route elements wired to the backend (contact form, status probe).
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Contact as ContactPage, Status as StatusPage } from "./Pages";

/** Convex HTTP actions live on *.convex.site; the client URL is *.convex.cloud. */
export function apiBaseUrl(): string | undefined {
  const explicit = import.meta.env.VITE_USOPGRID_API_URL as string | undefined;
  if (explicit) return explicit.replace(/\/$/, "");
  const cloud = import.meta.env.VITE_CONVEX_URL as string | undefined;
  return cloud ? cloud.replace(".convex.cloud", ".convex.site").replace(/\/$/, "") : undefined;
}

export function ContactRoute() {
  const submit = useMutation(api.contact.submit);
  return <ContactPage submit={(d) => submit(d)} />;
}

export function StatusRoute() {
  return <StatusPage apiBase={apiBaseUrl()} />;
}
