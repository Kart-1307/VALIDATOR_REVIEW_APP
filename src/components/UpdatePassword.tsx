import { useState } from 'react';
import { Layers, Lock, AlertCircle, Check } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';

export default function UpdatePassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // Set when Supabase rejects the update because the recovery session behind
  // this screen has expired/is invalid — distinct from a plain validation
  // error, since retrying the same form can't fix it; the person needs to
  // request a brand new link instead.
  const [sessionExpired, setSessionExpired] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      if (/expired|invalid|jwt/i.test(error.message)) {
        setSessionExpired(true);
      } else {
        setError(error.message);
      }
    } else {
      setDone(true);
      setTimeout(onDone, 1500);
    }
  };

  return (
    <div className="min-h-screen bg-[#e8eaf6] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 justify-center mb-8">
          <span className="w-9 h-9 rounded-lg bg-[#ececed] border border-[#e4e4e7] flex items-center justify-center text-[#4f46e5]">
            <Layers className="w-4.5 h-4.5" />
          </span>
          <h1 className="text-sm font-bold tracking-tight text-zinc-900">Set a new password</h1>
        </div>

        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-6 shadow-sm">
          {done ? (
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <Check className="w-4 h-4" /> Password updated — signing you in…
            </div>
          ) : sessionExpired ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                This reset link has expired or was already used. Go back and request a new one.
              </div>
              <button
                type="button"
                onClick={onDone}
                className="flex items-center justify-center gap-1.5 py-2.5 text-sm font-bold rounded-lg bg-[#6366f1] hover:bg-indigo-700 text-white transition-all cursor-pointer"
              >
                Back to Sign In
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="relative">
                <Lock className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  minLength={6}
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 bg-[#e8eaf6] border border-[#e4e4e7] rounded-lg text-sm text-zinc-700 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                />
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  minLength={6}
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 bg-[#e8eaf6] border border-[#e4e4e7] rounded-lg text-sm text-zinc-700 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                />
              </div>
              {error && (
                <div className="flex items-start gap-2 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="mt-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-bold rounded-lg bg-[#6366f1] hover:bg-indigo-700 text-white transition-all cursor-pointer disabled:opacity-60"
              >
                {loading ? 'Updating…' : 'Update Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
