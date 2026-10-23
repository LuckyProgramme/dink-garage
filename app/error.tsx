"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>A short pause.</h1>
        <p>
          The service is temporarily unavailable. Your recordings and settings
          have not been changed by this page.
        </p>
        <button className="primary" onClick={reset}>
          Try again
        </button>
        <a className="auth-switch" href="/">
          Back to Dink Vision
        </a>
      </section>
    </main>
  );
}
