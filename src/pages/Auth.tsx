import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";

import { useAuth } from "@/hooks/use-auth";
import { UsopgridLogo, USOPGRID_COMPANY, USOPGRID_DESCRIPTOR, USOPGRID_TAGLINE } from "@/components/brand";
import { ArrowRight, Building2, Loader2, Mail, UserX } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signInOptions = useQuery(api.signInOptions.list, {});

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);
  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      setStep({ email: formData.get("email") as string });
      setIsLoading(false);
    } catch (error) {
      console.error("Email sign-in error:", error);
      setError(
        error instanceof Error
          ? error.message
          : "Failed to send verification code. Please try again.",
      );
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);

      

      navigate(redirect);
    } catch (error) {
      console.error("OTP verification error:", error);

      setError("The verification code you entered is incorrect.");
      setIsLoading(false);

      setOtp("");
    }
  };

  const handleSso = async (provider: string) => {
    setIsLoading(true);
    setError(null);
    try {
      // OAuth/OIDC providers redirect to the identity provider and back.
      await signIn(provider, { redirectTo: redirect });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Single sign-on is unavailable. Try email instead.");
      setIsLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("anonymous");
      navigate(redirect);
    } catch (error) {
      console.error("Guest login error:", error);
      setError(`Failed to sign in as guest: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      <aside className="flex flex-col justify-between gap-10 border-b-2 border-gold bg-navy px-6 py-5 text-ivory lg:w-[42%] lg:border-b-0 lg:border-r-2 lg:px-14 lg:py-14">
        <button type="button" onClick={() => navigate("/")} aria-label="USOPGRID home" className="self-start">
          <UsopgridLogo tone="onDark" markClassName="size-9" wordClassName="text-[21px]" />
        </button>
        <div className="hidden max-w-md lg:block">
          <p className="font-display text-4xl font-semibold leading-tight text-ivory">{USOPGRID_TAGLINE}</p>
          <div className="my-6 h-px w-16 bg-gold" />
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-champagne">{USOPGRID_DESCRIPTOR}</p>
          <ul className="mt-8 space-y-3 text-sm text-[#C6CAD3]">
            <li>One account for every provider, currency and market you connect.</li>
            <li>Every payment routed, recovered and reconciled to the last unit.</li>
            <li>Multi-factor authentication and full audit trails as standard.</li>
          </ul>
        </div>
        <p className="hidden text-xs text-[#C6CAD3]/70 lg:block">© {USOPGRID_COMPANY}</p>
      </aside>

      {/* Auth Content */}
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="flex w-full max-w-[420px] flex-col">
        <Card className="w-full gap-0 rounded-md border pb-0 shadow-none">
          {step === "signIn" ? (
            <>
              <CardHeader className="pt-6 text-left">
                <p className="pt-2 text-[11px] font-medium uppercase tracking-[0.16em] text-gold-ink">Secure sign-in</p>
                <CardTitle className="font-display text-2xl font-semibold text-heading">Sign in to USOPGRID</CardTitle>
                <CardDescription className="pb-2">
                  Enter your work email. We'll send a one-time code.
                </CardDescription>
              </CardHeader>
              <form onSubmit={handleEmailSubmit}>
                <CardContent>
                  
                  <div className="relative flex items-center gap-2">
                    <div className="relative flex-1">
                      <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        name="email"
                        placeholder="name@example.com"
                        type="email"
                        className="pl-9"
                        disabled={isLoading}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="outline"
                      size="icon"
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <ArrowRight className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {error && (
                    <p className="mt-2 text-sm text-status-failed">{error}</p>
                  )}
                  
                  <div className="mt-4">
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t" />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-background px-2 text-muted-foreground">
                          Or
                        </span>
                      </div>
                    </div>
                    
                    {(signInOptions?.sso ?? []).map((p) => (
                      <Button
                        key={p.id}
                        type="button"
                        variant="outline"
                        className="w-full mt-4"
                        disabled={isLoading}
                        onClick={() => void handleSso(p.id)}
                      >
                        <Building2 className="mr-2 h-4 w-4" />
                        Continue with {p.label}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full mt-4"
                      onClick={handleGuestLogin}
                      disabled={isLoading}
                    >
                      <UserX className="mr-2 h-4 w-4" />
                      Explore the sandbox as a guest
                    </Button>
                  </div>
                </CardContent>
              </form>
            </>
          ) : (
            <>
              <CardHeader className="pt-6 text-left">
                <CardTitle className="font-display text-2xl font-semibold text-heading">Check your email</CardTitle>
                <CardDescription>
                  We've sent a code to {step.email}
                </CardDescription>
              </CardHeader>
              <form onSubmit={handleOtpSubmit}>
                <CardContent className="pb-4">
                  <input type="hidden" name="email" value={step.email} />
                  <input type="hidden" name="code" value={otp} />

                  <div className="flex justify-center">
                    <InputOTP
                      value={otp}
                      onChange={setOtp}
                      maxLength={OTP_LENGTH}
                      disabled={isLoading}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && otp.length === OTP_LENGTH && !isLoading) {
                          // Find the closest form and submit it
                          const form = (e.target as HTMLElement).closest("form");
                          if (form) {
                            form.requestSubmit();
                          }
                        }
                      }}
                    >
                      <InputOTPGroup>
                        {Array.from({ length: OTP_LENGTH }).map((_, index) => (
                          <InputOTPSlot key={index} index={index} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                  {error && (
                    <p className="mt-2 text-sm text-status-failed text-center">
                      {error}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground text-center mt-4">
                    Didn't receive a code?{" "}
                    <Button
                      variant="link"
                      className="p-0 h-auto"
                      onClick={() => setStep("signIn")}
                    >
                      Try again
                    </Button>
                  </p>
                </CardContent>
                <CardFooter className="flex-col gap-2">
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isLoading || otp.length !== OTP_LENGTH}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Verifying...
                      </>
                    ) : (
                      <>
                        Verify code
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setStep("signIn")}
                    disabled={isLoading}
                    className="w-full"
                  >
                    Use different email
                  </Button>
                </CardFooter>
              </form>
            </>
          )}

          <div className="mt-6 rounded-b-md border-t bg-muted px-6 py-4 text-center text-xs text-muted-foreground">
            One-time codes expire after 15 minutes. USOPGRID staff will never ask you for one.
          </div>
        </Card>
        </div>
      </div>
    </div>
  );
}

/** Must match the length generated in src/convex/auth/emailOtp.ts. */
const OTP_LENGTH = 8;

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
