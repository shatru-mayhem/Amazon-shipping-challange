"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type PortalKind = "client" | "employee";

interface LoginModalProps {
  portal: PortalKind;
  onClose: () => void;
}

// MOCK AUTH - code-access with email confirmation, per landpage.md.
// TO BE REPLACED BY REAL AUTH SERVICE. Input ports kept open for API integration.
export default function LoginModal({ portal, onClose }: LoginModalProps) {
  const router = useRouter();
  const [step, setStep] = useState<"credentials" | "confirm">("credentials");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const isEmployee = portal === "employee";
  const title = isEmployee ? "Amazon Employee Portal" : "Client Portal";

  function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    if (code.trim().length < 4) {
      setError("Enter your access code (minimum 4 characters).");
      return;
    }
    if (isEmployee && !email.toLowerCase().endsWith("@amazon.com")) {
      setError("Employee access requires an @amazon.com email.");
      return;
    }
    setError("");
    setStep("confirm");
  }

  function confirmEmail() {
    router.push(isEmployee ? "/employee" : "/client");
  }

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
            <p className="text-sm text-gray-600">Code-access sign in</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close sign in"
            className="rounded-sm px-2 py-1 text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        {step === "credentials" ? (
          <form onSubmit={submitCredentials} noValidate>
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
            <label htmlFor="code" className="mb-1 block text-sm font-medium">
              Access code
            </label>
            <input
              id="code"
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mb-1 h-11 w-full rounded-sm border border-border px-3 text-sm"
              placeholder="Provided by your Amazon contact"
            />
            {error ? (
              <p className="mt-2 text-sm text-danger" role="alert">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              className="mt-4 h-11 w-full rounded-sm bg-orange font-medium text-ink hover:bg-orange-dark"
            >
              Continue
            </button>
            {isEmployee ? (
              <p className="mt-3 text-xs text-gray-500">
                Your dashboard is tailored to your place in the company
                hierarchy and logistical chain.
              </p>
            ) : (
              <p className="mt-3 text-xs text-gray-500">
                Access is scoped to your projects and data only.
              </p>
            )}
          </form>
        ) : (
          <div>
            <p className="text-sm">
              A confirmation link was sent to{" "}
              <span className="font-medium">{email}</span>.
            </p>
            <p className="mt-2 text-xs text-gray-500">
              (Preview mock — no email is actually sent.)
            </p>
            <button
              onClick={confirmEmail}
              className="mt-4 h-11 w-full rounded-sm bg-orange font-medium text-ink hover:bg-orange-dark"
            >
              I confirmed my email — enter portal
            </button>
            <button
              onClick={() => setStep("credentials")}
              className="mt-2 h-11 w-full rounded-sm border border-border text-sm text-link hover:bg-gray-50"
            >
              Use a different email
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
