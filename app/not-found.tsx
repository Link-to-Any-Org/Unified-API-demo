import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Page not found</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link
        href="/"
        className="text-sm font-medium text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to home
      </Link>
    </div>
  );
}
