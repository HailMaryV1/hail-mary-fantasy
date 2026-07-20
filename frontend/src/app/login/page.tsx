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
        <h1 className="text-2xl font-semibold text-white">
          Hail Mary<span className="text-sky-400">.</span>
        </h1>
        <p className="mt-1 text-sm text-navy-300">Sign in</p>

        {error && (
          <p className="mt-4 rounded-lg bg-red-950 p-3 text-sm text-red-300">{error}</p>
        )}

        <form className="mt-6 flex flex-col gap-3">
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

          <div className="mt-2 flex gap-2">
            <button
              formAction={signIn}
              className="flex-1 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400"
            >
              Sign in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
