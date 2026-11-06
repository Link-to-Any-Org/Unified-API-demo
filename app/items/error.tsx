"use client";

export default function ItemsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center dark:bg-black">
      <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
        Couldn&apos;t load the catalog
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400">Something went wrong loading your items.</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background"
      >
        Try again
      </button>
    </div>
  );
}
