// supabase/functions/generate-desmos-solution/index.ts
//
// Generates a genuinely per-question "Digital SAT-style solution, with Desmos"
// write-up by calling the Anthropic API with this specific item's stimulus,
// question text, and answer choices.
//
// Why this exists: `buildDesmosSolution` in src/lib/mathTools.ts is a small
// set of hand-written templates (systems of equations / quadratics / function
// evaluation / one generic fallback) chosen by keyword matching. That's fine
// as a zero-config, zero-API-key default, but it means most items that don't
// match one of those three keyword patterns all render the same generic
// fallback text — which is the bug being fixed here. This function produces
// a strategy/steps write-up tailored to the actual question content instead.
// The client (QuestionCard.tsx) calls this first and only falls back to the
// static template if the call fails or no ANTHROPIC_API_KEY is configured,
// so the app still works out of the box with zero extra setup.
//
// Deploy:
//   supabase functions deploy generate-desmos-solution
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// SUPABASE_URL and SUPABASE_ANON_KEY are auto-injected into every Edge
// Function; ANTHROPIC_API_KEY must be set manually (above) since it's not
// a Supabase-managed secret.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const allowedOrigin = Deno.env.get('SITE_URL') || '*';
const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

interface DesmosStep {
  title: string;
  detail: string;
  desmosAction: string;
}

interface DesmosSolution {
  strategy: string;
  steps: DesmosStep[];
  desmosSummary: string;
}

// Keeps the model's JSON honest: every field must be present and correctly
// typed, and we cap step count so a malformed/adversarial response can't
// balloon into something the UI wasn't built to render.
function isValidSolution(value: unknown): value is DesmosSolution {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.strategy !== 'string' || !v.strategy.trim()) return false;
  if (typeof v.desmosSummary !== 'string' || !v.desmosSummary.trim()) return false;
  if (!Array.isArray(v.steps) || v.steps.length < 2 || v.steps.length > 6) return false;
  return v.steps.every((s) => {
    if (!s || typeof s !== 'object') return false;
    const step = s as Record<string, unknown>;
    return (
      typeof step.title === 'string' && step.title.trim() &&
      typeof step.detail === 'string' && step.detail.trim() &&
      typeof step.desmosAction === 'string' && step.desmosAction.trim()
    );
  });
}

// Anthropic responses are instructed to be JSON-only, but strip code fences
// defensively in case the model wraps it in ```json anyway.
function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: jsonHeaders });
  }

  try {
    // Require a logged-in caller (any active role — validators/admins/auditors
    // all read solutions), same pattern as send-validator-invite, just without
    // the admin-only restriction since this is a read-style helper, not a
    // privileged mutation.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), { status: 401, headers: jsonHeaders });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired session' }), { status: 401, headers: jsonHeaders });
    }

    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      return new Response(
        JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured for this project.' }),
        { status: 501, headers: jsonHeaders }
      );
    }

    const body = await req.json().catch(() => ({}));
    const question = body?.question;
    if (!question || typeof question !== 'object') {
      return new Response(JSON.stringify({ error: 'question is required' }), { status: 400, headers: jsonHeaders });
    }

    // Pull only what the model needs — keeps the prompt small and avoids
    // shipping unrelated internal fields (claimedBy, comments, etc.) upstream.
    const {
      question: questionText,
      stimulus,
      passage,
      choices,
      correct_answer: correctAnswer,
      category,
      subSkill,
      difficulty
    } = question as Record<string, unknown>;

    const choicesText = choices && typeof choices === 'object'
      ? Object.entries(choices as Record<string, string>)
          .map(([key, val]) => `${key}) ${val}`)
          .join('\n')
      : '(grid-in / no multiple-choice options)';

    const prompt = `You are writing a short, concrete study-guide entry for a Digital SAT math item. Produce a step-by-step strategy for solving THIS SPECIFIC question using Desmos (the graphing calculator), not a generic template.

Question category: ${category || 'unspecified'}
Sub-skill: ${subSkill || 'unspecified'}
Difficulty: ${difficulty || 'unspecified'}
Stimulus/passage: ${stimulus || passage || '(none)'}
Question: ${questionText || '(not provided)'}
Answer choices:
${choicesText}
Correct answer key: ${correctAnswer || '(not provided — grid-in)'}

Write a solution that references the ACTUAL numbers, expressions, and phrasing in this question wherever possible (e.g. real coefficients, the real function name, the real requested quantity) rather than placeholders like "[expression from the question]". Tailor the number of steps and the strategy to what this question actually requires — don't force it into an unrelated template.

Respond with ONLY a JSON object, no prose before or after, no markdown code fences, matching exactly this shape:
{
  "strategy": "1-2 sentence overview of why this approach fits this specific question",
  "steps": [
    { "title": "1. ...", "detail": "...", "desmosAction": "the literal Desmos input or click, referencing real values from this question" }
  ],
  "desmosSummary": "1 sentence recap"
}
Use 2 to 5 steps, whatever this question actually needs.`;

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text().catch(() => '');
      return new Response(
        JSON.stringify({ error: `Anthropic API error (${anthropicResponse.status}): ${errText.slice(0, 300)}` }),
        { status: 502, headers: jsonHeaders }
      );
    }

    const anthropicData = await anthropicResponse.json();
    const textBlock = (anthropicData?.content || []).find((c: { type: string }) => c.type === 'text');
    if (!textBlock?.text) {
      return new Response(JSON.stringify({ error: 'Anthropic response contained no text content.' }), { status: 502, headers: jsonHeaders });
    }

    let parsed: unknown;
    try {
      parsed = extractJson(textBlock.text);
    } catch {
      return new Response(JSON.stringify({ error: 'Could not parse the generated solution as JSON.' }), { status: 502, headers: jsonHeaders });
    }

    if (!isValidSolution(parsed)) {
      return new Response(JSON.stringify({ error: 'Generated solution did not match the expected shape.' }), { status: 502, headers: jsonHeaders });
    }

    return new Response(JSON.stringify({ solution: parsed }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: jsonHeaders });
  }
});
