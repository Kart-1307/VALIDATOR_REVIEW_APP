// supabase/functions/send-validator-invite/index.ts
//
// Sends the actual invite email for a pre-authorized validator.
//
// Why this exists: previously, "Add Pre-auth Invite" only wrote a row into
// `validator_invites` — a whitelist entry the `handle_new_user` DB trigger
// checks *if and when* someone signs up with that email. Nothing ever
// notified the invitee, so admins had to separately message every person
// out-of-band with their exact email. This function closes that gap by
// calling Supabase Auth's admin.inviteUserByEmail(), which:
//   1. Creates the auth.users row immediately (unconfirmed / no password yet)
//   2. Sends Supabase's hosted "You've been invited" email with a link to
//      set a password and land back in the app
//   3. Firing (2) triggers `handle_new_user` right away, which matches the
//      pending validator_invites row by email, creates their `profiles` row
//      with the pre-set name/role, sets active=true, and consumes the
//      invite — exactly as it already did for self-signup, just triggered
//      immediately instead of waiting for the person to register manually.
//
// This must run server-side because inviteUserByEmail requires the
// service-role key, which must never be shipped to the browser.
//
// Deploy:
//   supabase functions deploy send-validator-invite
//
// No manual secrets needed — SUPABASE_URL, SUPABASE_ANON_KEY, and
// SUPABASE_SERVICE_ROLE_KEY are auto-injected into every Edge Function.
// Optionally set SITE_URL (supabase secrets set SITE_URL=https://your-app-domain)
// so the emailed link redirects back to your deployed app instead of
// Supabase's default.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Client scoped to the caller's own JWT — used only to verify who is calling.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Privileged client for the admin check + the actual invite call.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: callerProfile, error: profileError } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single();

    if (profileError || callerProfile?.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Only admins can send validator invites' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const role = typeof body.role === 'string' ? body.role : 'validator';

    if (!email || !name) {
      return new Response(JSON.stringify({ error: 'email and name are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!['validator', 'admin', 'auditor'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Invalid role' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const siteUrl = Deno.env.get('SITE_URL') || undefined;

    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { name },
      redirectTo: siteUrl
    });

    if (inviteError) {
      // Common case: this email already has an auth.users row (already
      // invited or already a real account). Surface that clearly instead of
      // a raw Supabase error string.
      const alreadyExists = /already registered|already exists/i.test(inviteError.message || '');
      return new Response(
        JSON.stringify({
          error: alreadyExists
            ? 'This email already has an account or a pending invite email.'
            : inviteError.message
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ success: true, userId: inviteData?.user?.id }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
