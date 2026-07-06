import Link from "next/link";

interface TopBarProps {
  context?: string;
  showBack?: boolean;
}

export default function TopBar({ context, showBack = false }: TopBarProps) {
  return (
    <header className="bg-ink text-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        <Link href="/" className="flex items-baseline gap-1 font-bold">
          <span className="text-lg">amazon</span>
          <span className="text-orange text-lg leading-none">›</span>
          <span className="ml-1 text-sm font-normal text-gray-300">
            Supply Chain Services
          </span>
        </Link>
        {context ? (
          <span className="rounded-sm border border-navy bg-navy px-2 py-0.5 text-xs text-gray-200">
            {context}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-4 text-sm">
          {showBack ? (
            <Link
              href="/"
              className="text-gray-300 underline-offset-2 hover:text-white hover:underline"
            >
              Sign out
            </Link>
          ) : (
            <span className="text-xs text-gray-400">
              Internal preview — sample data
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
