"use client";

import "./globals.css";

// Replaces the root layout when the layout itself throws, so it renders its
// own <html>/<body>.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="opacity-70">The app hit an unexpected error.</p>
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:bg-foreground-hover"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
