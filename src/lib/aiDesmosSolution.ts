import { supabase } from './supabaseClient';
import { SATQuestion } from '../types';
import { DesmosSolution } from './mathTools';

// Calls the `generate-desmos-solution` Edge Function, which asks the
// Anthropic API for a solution write-up tailored to this specific question's
// actual numbers/wording — as opposed to `buildDesmosSolution` in
// mathTools.ts, which is a small set of hand-written templates chosen by
// keyword matching and falls back to one generic write-up for anything that
// doesn't match. Callers should catch/handle rejection and fall back to
// `buildDesmosSolution` themselves — this function does not do that fallback
// internally so the caller can distinguish "used AI" from "used template" in
// the UI if it wants to.
//
// Requires the project to have `ANTHROPIC_API_KEY` set as a Supabase Edge
// Function secret (see supabase/functions/generate-desmos-solution/index.ts).
// Without it, the function returns a clear error and this rejects — callers
// should treat that as "not configured" rather than a hard failure.
export async function fetchAiDesmosSolution(question: SATQuestion): Promise<DesmosSolution> {
  // Only send the fields the model actually needs — keeps the payload small
  // and avoids shipping internal-only fields (claimedBy, comments, audit
  // metadata, etc.) to the function.
  const trimmedQuestion = {
    question: question.question,
    stimulus: question.stimulus,
    passage: question.passage,
    choices: question.choices,
    correct_answer: question.correct_answer,
    category: question.category,
    subSkill: question.subSkill,
    difficulty: question.difficulty
  };

  const { data, error } = await supabase.functions.invoke('generate-desmos-solution', {
    body: { question: trimmedQuestion }
  });

  if (error) {
    throw new Error(error.message || 'Failed to generate an AI Desmos solution.');
  }
  if (!data?.solution) {
    throw new Error(data?.error || 'No solution returned.');
  }
  return data.solution as DesmosSolution;
}
