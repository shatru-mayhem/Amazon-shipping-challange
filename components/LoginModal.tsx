"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  requestLoginCode,
  verifyLoginCode,
  signInWithAccessCode,
} from "@/app/actions/auth";

export type PortalKind = "client" | "employee";

interface LoginModalProps {
  portal: PortalKind;
  onClose: () => void;
}

// Client: email -> access code emailed -> verify -> portal.
// Employee: email + standing access code (head account); or emailed code.
export default function LoginModal({ portal, onClose }: LoginModalProps) {
  const router = useRouter();
  const isEmployee = portal === "employee";
  const [step, setStep] = useState<"email" | "verify">("email");
  const [useEmailedCode, setUseEmailedCode] = useState(!isEmployee);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const title = isEmployee ? "Amazon Employee Portal" : "Client Portal";

  function sendCode(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await requestLoginCode(email);
      if (!res.ok) return setError(res.error ?? "Could not send code.");
      setError("");
      setStep("verify");
    });
  }

  function verifyEmailed(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await verifyLoginCode(email, code, portal);
      if (!res.ok || !res.data) return setError(res.error ?? "Invalid code.");
      router.push(res.data.destination);
    });
  }

  function standingCode(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await signInWithAccessCode(email, code, portal);
      if (!res.ok || !res.data) return setError(res.error ?? "Sign-in failed.");
      router.push(res.data.destination);
    });
  }

  const emailInput = (
    <>
      <label htmlFor="email" className="mb-1 block text-sm font-medium">
        Email address
      </label>
      <input
        id="email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mb-4 h-11 w-full rounded-sm border border-border px-3 text-sm"
        placeholder={isEmployee ? "you@amazon.com" : "you@company.com"}
      />
    </>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title + " sign in"}
    >
      <div className="w-full max-w-md rounded-md border border-border bg-surface p-6 shadow-lg">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold">{title}</h2>
            <p className="text-sm text-gray-600">
              {useEmailedCode
                ? "We’ll email you an access code"
                : "Sign in with your standing access code"}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close sign in"
            className="rounded-sm px-2 py-1 text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        {useEmailedCode && step === "email" ? (
          <form onSubmit={sendCode} noValidate>
            {emailInput}
            <ErrorText error={error} />
            <Submit pending={pending} label="Email me an access code" />
          </form>
        ) : null}

        {useEmailedCode && step === "verify" ? (
          <form onSubmit={verifyEmailed} noValidate>
            <p className="mb-3 text-sm">
              Enter the code sent to <span className="font-medium">{email}</span>.
            </p>
            <CodeInput code={code} setCode={setCode} />
            <ErrorText error={error} />
            <Submit pending={pending} label="Verify and enter portal" />
            <button
              type="button"
              onClick={() => setStep("email")}
              className="mt-2 h-11 w-full rounded-sm border border-border text-sm text-link hover:bg-gray-50"
            >
              Use a different email
            </button>
          </form>
        ) : null}

        {!useEmailedCode ? (
          <form onSubmit={standingCode} noValidate>
            {emailInput}
            <CodeInput code={code} setCode={setCode} />
            <ErrorText error={error} />
            <Submit pending={pending} label="Sign in" />
            <button
              type="button"
              onClick={() => {
                setUseEmailedCode(true);
                setStep("email");
                setError("");
              }}
              className="mt-2 h-11 w-full rounded-sm border border-border text-sm text-link hover:bg-gray-50"
            >
              Email me a code instead
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function CodeInput({ code, setCode }: { code: string; setCode: (v: string) => void }) {
  return (
    <>
      <label htmlFor="code" className="mb-1 block text-sm font-medium">
        Access code
      </label>
      <input
        id="code"
        type="password"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="mb-1 h-11 w-full rounded-sm border border-border px-3 text-sm"
        autoComplete="one-time-code"
      />
    </>
  );
}

function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="mt-2 text-sm text-danger" role="alert">
      {error}
    </p>
  ) : null;
}

function Submit({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-4 h-11 w-full rounded-sm bg-orange font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
    >
      {pending ? "Working…" : label}
    </button>
  );
}
