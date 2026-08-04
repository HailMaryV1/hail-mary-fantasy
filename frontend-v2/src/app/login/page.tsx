import Image from "next/image";
import { signIn } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy-950 px-6">
      <div className="w-full max-w-sm">
        <Image src="/logo.png" alt="Hail Mary" width={72} height={74} className="mb-6" priority />

        {error && <p className="mb-4 rounded-lg bg-red-950 p-3 text-sm text-red-300">{error}</p>}

        <form className="flex flex-col gap-3">
          <label className="text-sm font-medium text-navy-200">
            Email
            <input
              name="email"
              type="email"
              required
              className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            />
          </label>
          <label className="text-sm font-medium text-navy-200">
            Password
            <input
              name="password"
              type="password"
              required
              minLength={6}
              className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            />
          </label>

          <button
            formAction={signIn}
            className="mt-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400"
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
