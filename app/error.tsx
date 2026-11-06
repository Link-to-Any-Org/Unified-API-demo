"use client";

// Fallback for errors in any route without its own error.tsx (e.g. "/").
// Errors in the root layout itself are handled by global-error.tsx.
export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center dark:bg-black">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">Something went wrong</h1>
      <p className="text-zinc-600 dark:text-zinc-400">The page couldn&apos;t be loaded.</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:bg-foreground-hover"
      >
        Try again
      </button>
    </div>
  );
}
