import { useState, useEffect } from 'react';
import { Layers, Mail, Lock, User as UserIcon, LogIn, UserPlus, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';

interface LoginProps {
  // Set when the app detects an expired/invalid password-reset link in the
  // URL (see App.tsx) — shown as an error and drops the person straight into
  // the forgot-password form instead of a plain, unexplained Sign In screen.
  initialError?: string | null;
  initialMode?: 'signin' | 'signup' | 'forgot';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_COOLDOWN_SECONDS = 30;

export default function Login({ initialError = null, initialMode = 'signin' }: LoginProps) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  // Prevents spamming Supabase's reset endpoint and gives clear feedback
  // that the request went through rather than looking like nothing happened.
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  // --- SSO (spec §2): requires the Google provider enabled in your Supabase
  // project's Auth settings (Authentication → Providers → Google) — this
  // button just kicks off the OAuth redirect flow, no secrets live here.
  const handleGoogleSignIn = async () => {
    setError(null);
    setSsoLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin }
    });
    if (error) {
      setError(error.message);
      setSsoLoading(false);
    }
    // On success the browser redirects away, so no need to reset loading here.
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (mode === 'forgot') {
      if (!EMAIL_PATTERN.test(email.trim())) {
        setError('Enter a valid email address.');
        return;
      }
      if (resendCooldown > 0) return;
    }

    setLoading(true);

    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin
        });
        // Backend failures (network/outage/rate limit) are surfaced as errors;
        // an unrecognized email is deliberately NOT distinguished from success
        // below, to avoid leaking which addresses have accounts.
        if (error) throw error;
        setInfo('If that email has an account, a password reset link has been sent. Click the link in that email — it will bring you back here to set a new password.');
        setResendCooldown(RESEND_COOLDOWN_SECONDS);
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name: name || email.split('@')[0] } }
        });
        if (error) throw error;
        setInfo('Account created. If email confirmation is enabled on your Supabase project, check your inbox before signing in.');
      }
    } catch (err: any) {
      // Map common Supabase failure modes to messages a validator can act on.
      const raw: string = err?.message || '';
      if (err?.status === 429 || /rate limit/i.test(raw)) {
        setError('Too many attempts. Please wait a minute before trying again.');
      } else if (/network|fetch/i.test(raw)) {
        setError('Could not reach the authentication server. Check your connection and try again.');
      } else if (mode === 'signin' && /invalid login credentials/i.test(raw)) {
        setError('Incorrect email or password.');
      } else {
        setError(raw || 'Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#e8eaf6] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 justify-center mb-8">
          <span className="w-9 h-9 rounded-lg bg-[#ececed] border border-[#e4e4e7] flex items-center justify-center text-[#4f46e5]">
            <Layers className="w-4.5 h-4.5" />
          </span>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-zinc-900">SAT Test Bank Curation Portal</h1>
            <p className="text-[12px] text-zinc-500 font-medium">Official Audit &amp; Approval Console</p>
          </div>
        </div>

        <div className="bg-[#fafafa] border border-[#e4e4e7] rounded-xl p-6 shadow-sm">
          {/* SSO (spec §2) — enable the Google provider in Supabase Auth settings to activate */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={ssoLoading}
            className="w-full mb-4 flex items-center justify-center gap-2 py-2.5 text-xs font-bold rounded-lg bg-[#e8eaf6] hover:bg-zinc-100 text-zinc-600 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/>
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
              <path fill="#4CAF50" d="M24 44c5.4 0 10.3-2.1 14-5.5l-6.5-5.4C29.6 34.8 26.9 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.6 5.1C9.6 39.6 16.3 44 24 44z"/>
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.5 5.4C40.9 36.3 44 30.9 44 24c0-1.3-.1-2.7-.4-3.5z"/>
            </svg>
            {ssoLoading ? 'Redirecting…' : 'Continue with Google'}
          </button>
          <div className="flex items-center gap-2 mb-4">
            <div className="h-px flex-1 bg-[#e4e4e7]" />
            <span className="text-[11px] text-zinc-600 uppercase tracking-wide">or</span>
            <div className="h-px flex-1 bg-[#e4e4e7]" />
          </div>

          <div className="flex gap-1 mb-5 bg-[#e8eaf6] border border-[#e4e4e7] rounded-lg p-1">
            <button
              type="button"
              onClick={() => { setMode('signin'); setError(null); setInfo(null); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                mode === 'signin' ? 'bg-[#6366f1] text-white' : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" /> Sign In
            </button>
            <button
              type="button"
              onClick={() => { setMode('signup'); setError(null); setInfo(null); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                mode === 'signup' ? 'bg-[#6366f1] text-white' : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" /> Create Account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {mode === 'signup' && (
              <div className="relative">
                <UserIcon className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  placeholder="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 bg-[#e8eaf6] border border-[#e4e4e7] rounded-lg text-sm text-zinc-700 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
                />
              </div>
            )}
            <div className="relative">
              <Mail className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 bg-[#e8eaf6] border border-[#e4e4e7] rounded-lg text-sm text-zinc-700 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
              />
            </div>
            {mode !== 'forgot' && (
            <div className="relative">
              <Lock className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                required
                minLength={6}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 bg-[#e8eaf6] border border-[#e4e4e7] rounded-lg text-sm text-zinc-700 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#6366f1] focus:border-[#6366f1]"
              />
            </div>
            )}

            {mode === 'signin' && (
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError(null); setInfo(null); }}
                className="text-[12px] text-zinc-500 hover:text-zinc-600 text-left -mt-1 cursor-pointer"
              >
                Forgot password?
              </button>
            )}

            {error && (
              <div className="flex items-start gap-2 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
              </div>
            )}
            {info && (
              <div className="text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">
                {info}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || (mode === 'forgot' && resendCooldown > 0)}
              className="mt-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-bold rounded-lg bg-[#6366f1] hover:bg-indigo-700 text-white transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading
                ? 'Please wait…'
                : mode === 'signin'
                  ? 'Sign In'
                  : mode === 'forgot'
                    ? (resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Send Reset Link')
                    : 'Create Account'}
            </button>

            {mode === 'forgot' && (
              <button
                type="button"
                onClick={() => { setMode('signin'); setError(null); setInfo(null); }}
                className="text-[12px] text-zinc-500 hover:text-zinc-600 cursor-pointer"
              >
                ← Back to sign in
              </button>
            )}
          </form>
        </div>

        <p className="text-[12px] text-zinc-600 text-center mt-4">
          New validators: create an account, then ask an admin to confirm access.
        </p>
      </div>
    </div>
  );
}
