import { SATQuestion } from '../types';

// --- Enhancement §1/§2: Desmos integration helpers -------------------------
// This module is intentionally dependency-free (no external AI call) so the
// app keeps working out of the box with zero extra API keys. The step-by-step
// solution / distractor-quality helpers below are template + heuristic based;
// swap `buildDesmosSolution` / `suggestDistractors` for a real LLM call later
// (e.g. a Supabase Edge Function hitting the Anthropic API) without touching
// any call sites — both are pure functions with a stable signature.

export function isMathQuestion(question: Pick<SATQuestion, 'Section' | 'section' | 'category'>): boolean {
  const s = `${question.Section || ''} ${question.section || ''} ${question.category || ''}`.toLowerCase();
  return s.includes('math');
}

// Pulls plausible graphable expressions (equations, functions, inequalities)
// out of a question's stimulus/body text so the Desmos modal can preload them
// instead of opening to a blank graph.
// Defense-in-depth cap: SAT stimulus/passage text is normally well under a
// few thousand characters, but nothing upstream enforces that. Scanning is
// linear in input length here (no catastrophic backtracking), but capping
// still bounds worst-case cost per render for an unusually large/malformed
// upload rather than relying on that always being true.
const MAX_EXTRACT_TEXT_LENGTH = 5000;

export function extractExpressions(question: Pick<SATQuestion, 'stimulus' | 'question' | 'passage'>): string[] {
  const text = [question.stimulus, question.question, question.passage]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_EXTRACT_TEXT_LENGTH);
  if (!text) return [];

  const found = new Set<string>();

  // Matches lines/fragments like "y = 2x + 3", "f(x) = x^2 - 4", "3x + 2y = 12",
  // "x^2 - 5x + 6 = 0", or simple inequalities "2x - 1 > 7".
  // Stops at commas/semicolons/newlines *and* sentence-ending punctuation
  // (., ?, !) so it doesn't run on into the next sentence of the question.
  const exprPattern = /(?:[a-zA-Z]\([a-zA-Z]\)|[a-zA-Z])\s*(?:=|>=|<=|>|<)\s*[^,\n;.?!]+/g;
  const matches = text.match(exprPattern) || [];

  for (const raw of matches) {
    // A single regex match can still span two equations joined by "and"
    // (e.g. "x + y = 10 and 2x - y = 5") since "and" isn't punctuation.
    // Split those back into individual candidate expressions so systems
    // of equations are recognized as 2+ expressions, not merged into one.
    const parts = raw.split(/\s+and\s+/i);

    for (let expr of parts) {
      expr = expr
        .trim()
        .replace(/\s+/g, ' ')
        // Normalize common plain-text math notation to Desmos-friendly syntax
        .replace(/\^/g, '^')
        .replace(/(\d)([a-zA-Z(])/g, '$1$2'); // keep implicit multiplication as-is; Desmos accepts "2x"

      // Trim trailing punctuation/words that aren't part of the expression
      expr = expr.replace(/[.?!]+$/, '').trim();

      // Skip anything too short or that isn't actually math (guards against
      // grabbing prose fragments like "It = the total number of...")
      if (expr.length < 3 || expr.length > 80) continue;
      if (!/[0-9x-zX-Z]/.test(expr)) continue;
      // A split-off tail part (everything after "and") must itself contain
      // a comparison operator to be a real second expression, not a stray
      // clause like "and the value of y".
      if (!/(?:=|>=|<=|>|<)/.test(expr)) continue;

      found.add(expr);
      if (found.size >= 6) break;
    }
    if (found.size >= 6) break;
  }

  return Array.from(found);
}

// Counts distinct single-letter unknowns (x, y, a, b, n, ...) referenced
// across a set of extracted expressions. Deliberately excludes single
// letters immediately followed by "(" (e.g. the "f" in "f(x)") since those
// are function names, not unknowns, and would otherwise inflate the count.
function countDistinctUnknowns(exprs: string[]): number {
  const vars = new Set<string>();
  for (const expr of exprs) {
    const matches = expr.match(/[a-zA-Z](?!\()/g) || [];
    for (const v of matches) vars.add(v.toLowerCase());
  }
  return vars.size;
}

export interface DesmosStep {
  title: string;
  detail: string;
  desmosAction: string;
}

export interface DesmosSolution {
  strategy: string;
  steps: DesmosStep[];
  desmosSummary: string;
}

// Produces a Digital-SAT-style, step-by-step write-up plus the equivalent
// "how to do this on Desmos" actions. Uses lightweight category/keyword
// detection to pick a relevant template; falls back to a general graphing
// strategy for anything it doesn't recognize.
export function buildDesmosSolution(question: SATQuestion): DesmosSolution {
  const exprs = extractExpressions(question);
  const category = (question.category || '').toLowerCase();
  const text = `${question.question} ${question.stimulus || ''}`.toLowerCase();

  const primary = exprs[0];
  const secondary = exprs[1];

  // Two-unknowns problems (classic systems of equations, or any item that
  // depends on two related quantities).
  //
  // Important: trying to pull BOTH unknowns out of Desmos at once (e.g. by
  // graphing two lines and clicking their intersection) is not a reliable
  // Digital-SAT strategy in general — it only works cleanly when both
  // relationships happen to be graphable exactly as given, and it's slow
  // and error-prone otherwise. The reliable version of this strategy is:
  // knock out ONE unknown by hand first (substitution, elimination, or a
  // quick read of a given clue — whatever's fastest mentally), which
  // collapses the problem to a single unknown, and only then hand that
  // single-variable equation to Desmos. Only fall into this branch when
  // there's real evidence of two distinct unknowns, not just two loosely
  // matched text fragments.
  const distinctUnknowns = countDistinctUnknowns(exprs);
  if (
    text.includes('system of equations') ||
    category.includes('system') ||
    (exprs.length >= 2 && distinctUnknowns >= 2)
  ) {
    return {
      strategy: 'This item has two unknowns. Don\'t try to pull both out of Desmos at once — graphing two relationships and clicking their intersection is slow and easy to mess up. Instead, knock out one unknown by hand first (substitution, elimination, or a quick clue in the problem), which leaves a single-variable equation, and only then bring Desmos in for that.',
      steps: [
        {
          title: '1. Find the unknown that\'s easiest to isolate',
          detail: 'Look at the given relationships and pick whichever move is fastest mentally: solve one equation for one variable, use a stated clue directly, or substitute one relationship into the other.',
          desmosAction: 'No calculator action yet — do this step by hand/mental math before opening Desmos.'
        },
        {
          title: '2. Substitute to collapse to one unknown',
          detail: 'Plug what you found in step 1 into the other relationship so only a single unknown remains. This is the algebra step Desmos can\'t do for you, but it\'s usually just one substitution.',
          desmosAction: 'Still no calculator action — write out the resulting single-variable equation before typing anything into Desmos.'
        },
        {
          title: '3. Let Desmos solve the single-variable equation',
          detail: `Enter the two sides of the resulting one-unknown equation as separate lines (y1 = ..., y2 = ...) and click their intersection, or graph y = [left side − right side] and read the x-intercept.`,
          desmosAction: `In Desmos: line 1 → ${primary || '[resulting equation, left side]'}${secondary ? `; line 2 → ${secondary}` : ''} — click the intersection.`
        },
        {
          title: '4. Back-substitute for the second unknown, then check',
          detail: 'Plug the value Desmos gave you back into the step-1 relationship to get the other unknown. Compute any requested combination (like x + y) from there, then match to the answer choices.',
          desmosAction: 'Type the back-substitution arithmetic into a blank Desmos line (e.g. "12 - 5") to double-check it, if helpful.'
        }
      ],
      desmosSummary: 'Solve for one unknown by hand first, substitute to get a single-variable equation, use Desmos only for that equation, then back-substitute for the second unknown.'
    };
  }

  // Quadratics / roots
  if (text.includes('quadratic') || /x\s*\^\s*2/.test(text) || category.includes('quadratic')) {
    return {
      strategy: 'This is a quadratic item. Rather than factoring by hand under time pressure, graph the expression and use Desmos to read the roots, vertex, or a specific value directly.',
      steps: [
        {
          title: '1. Set the expression equal to the graph',
          detail: 'Enter the quadratic exactly as written. If the question gives an equation like "expr = 0", enter just the left side as y = expr.',
          desmosAction: `In Desmos: y = ${primary ? primary.replace(/^[a-zA-Z]\s*=\s*/, '') : '[quadratic expression]'}`
        },
        {
          title: '2. Read the x-intercepts (roots)',
          detail: 'The points where the parabola crosses the x-axis are the solutions to expr = 0. Click each one — Desmos shows the exact or decimal value.',
          desmosAction: 'Click each x-axis crossing point to reveal its coordinates.'
        },
        {
          title: '3. Read the vertex (if the question asks for a max/min)',
          detail: 'Click the top or bottom point of the parabola to get the vertex coordinates directly — this instantly gives the max/min value and where it occurs.',
          desmosAction: 'Click the vertex point on the curve.'
        },
        {
          title: '4. Check against the answer choices',
          detail: 'Match the displayed root(s), vertex, or evaluated value to the closest answer choice, watching for sign and rounding.',
          desmosAction: 'Compare Desmos\'s displayed values to each choice; none should require estimation if entered correctly.'
        }
      ],
      desmosSummary: 'Graph the quadratic, click the roots and/or vertex to read exact values, then match to the answer choices.'
    };
  }

  // Function evaluation ("f(x) = ..., find f(3)")
  if (/f\s*\(\s*[a-z0-9]+\s*\)/.test(text) || category.includes('function')) {
    return {
      strategy: 'This is a function-evaluation item. Desmos will evaluate the function at any input instantly, which is faster and less error-prone than substituting by hand.',
      steps: [
        {
          title: '1. Enter the function definition',
          detail: 'Type the function exactly as given, e.g. f(x) = ... — Desmos treats this as a reusable function.',
          desmosAction: `In Desmos: ${primary && primary.match(/f\s*\(/) ? primary : 'f(x) = [given expression]'}`
        },
        {
          title: '2. Evaluate at the requested input',
          detail: 'On a new line, type f(value) using the input the question asks about — Desmos immediately shows the numeric result.',
          desmosAction: 'New line: f(value) — e.g. f(3)'
        },
        {
          title: '3. Reverse-check if solving for an input',
          detail: 'If the question instead gives the output and asks for the input, add the line y = [given output] and read the intersection with the function\'s graph.',
          desmosAction: 'Add a horizontal line y = k, then click its intersection with f(x).'
        },
        {
          title: '4. Confirm against the choices',
          detail: 'Match the evaluated result to the answer choices, double-checking sign and any rounding instructions.',
          desmosAction: 'Compare the value Desmos displays to each answer choice.'
        }
      ],
      desmosSummary: 'Define the function in Desmos, evaluate it at the given input (or intersect with y = k to reverse-solve), and match the result.'
    };
  }

  // Default / general linear or arithmetic strategy
  return {
    strategy: 'For this item, graphing the given relationship (or a rearranged form of it) in Desmos lets you check work numerically and visually instead of relying purely on algebra.',
    steps: [
      {
        title: '1. Translate the problem into an expression',
        detail: 'Rewrite what\'s being asked as an equation or function Desmos can plot, isolating the unknown on one side if possible.',
        desmosAction: `In Desmos: ${primary || 'y = [expression from the question]'}`
      },
      {
        title: '2. Use a table or graph to test values',
        detail: 'Add a table (type a bare list like "x = 1, 2, 3" or use the table tool) to see outputs for several inputs, or read the graph directly.',
        desmosAction: 'Click the "+" menu → Table, or trace along the plotted curve.'
      },
      {
        title: '3. Solve for the exact value needed',
        detail: 'If solving an equation, set the two sides as separate expressions (y1 = ..., y2 = ...) and click their intersection for the exact solution.',
        desmosAction: 'Enter both sides as y1 = ... and y2 = ..., then click the intersection point.'
      },
      {
        title: '4. Confirm against the answer choices',
        detail: 'Match the value(s) Desmos shows to the closest answer choice, watching for sign errors and unit/rounding requirements from the question.',
        desmosAction: 'Compare the displayed value to each choice.'
      }
    ],
    desmosSummary: 'Enter the relationship in Desmos, use the graph or a table to test values, and read off the exact solution instead of estimating by hand.'
  };
}

// --- Enhancement §3: distractor-quality assistant --------------------------

export type DistractorFlaw =
  | 'duplicate_of_correct'
  | 'blank_or_trivial'
  | 'not_plausible_numeric'
  | 'ok';

export interface DistractorAnalysis {
  key: 'A' | 'B' | 'C' | 'D';
  value: string;
  flaw: DistractorFlaw;
  note: string;
}

export interface DistractorSuggestion {
  label: string; // e.g. "Sign error"
  category: 'misconception' | 'arithmetic' | 'sign_error' | 'algebraic_manipulation' | 'partial_reasoning' | 'sat_trap';
  value: string;
  rationale: string;
}

// Flags obviously weak distractors so a validator can spot low-quality
// choices at a glance (exact duplicate of the key, empty, or — for numeric
// answers — wildly implausible).
export function analyzeDistractors(question: SATQuestion): DistractorAnalysis[] {
  // Bug fix: math grid-in questions (free numeric response, no A/B/C/D)
  // can have `choices` as null/undefined. Without this guard,
  // question.choices[...] throws and — since there's no error boundary —
  // crashes the whole app the instant the panel opens for one of these.
  const choices = question.choices || ({} as Partial<Record<'A' | 'B' | 'C' | 'D', string>>);
  const correctValue = choices[question.correct_answer as 'A' | 'B' | 'C' | 'D'];
  const correctNum = toNumber(correctValue);

  return (['A', 'B', 'C', 'D'] as const).map((key) => {
    const value = choices[key] || '';
    if (key === question.correct_answer) {
      return { key, value, flaw: 'ok', note: 'Correct answer' };
    }
    if (!value || !value.trim()) {
      return { key, value, flaw: 'blank_or_trivial', note: 'Empty choice — must be filled in.' };
    }
    if (value.trim() === (correctValue || '').trim()) {
      return { key, value, flaw: 'duplicate_of_correct', note: 'Identical to the correct answer — creates two "correct" options.' };
    }
    const num = toNumber(value);
    if (correctNum !== null && num !== null) {
      const magnitudeRatio = Math.abs(num) / (Math.abs(correctNum) || 1);
      if (magnitudeRatio > 50 || magnitudeRatio < 0.02) {
        return { key, value, flaw: 'not_plausible_numeric', note: 'Far outside a plausible range for this problem — likely to be dismissed by guessing rather than reasoning.' };
      }
    }
    return { key, value, flaw: 'ok', note: 'No obvious issue detected.' };
  });
}

// Generates candidate replacement distractors for a numeric correct answer,
// each tagged with the specific SAT-style mistake it represents. Validators
// can copy any suggestion into the Edit modal. For non-numeric (word-based)
// correct answers, returns qualitative guidance instead of fabricated values,
// since a formula can't safely invent plausible prose distractors.
export function suggestDistractors(question: SATQuestion): DistractorSuggestion[] {
  // Same null/undefined-choices guard as analyzeDistractors above.
  const choices = question.choices || ({} as Partial<Record<'A' | 'B' | 'C' | 'D', string>>);
  const correctValue = choices[question.correct_answer as 'A' | 'B' | 'C' | 'D'];
  const n = toNumber(correctValue);

  if (n === null) {
    return [
      {
        label: 'Common misconception',
        category: 'misconception',
        value: '(write an option reflecting a common misreading of the question, e.g. answering what was asked before the last step)',
        rationale: 'For non-numeric answers, base this on the specific misconception validators see most often for this category — a value that results from stopping one step early.'
      },
      {
        label: 'Common SAT trap',
        category: 'sat_trap',
        value: '(write an option that matches an intermediate quantity from the problem, not the final requested quantity)',
        rationale: 'Digital SAT distractors frequently reuse a number/phrase that appeared mid-problem but isn\'t the actual answer.'
      }
    ];
  }

  const isInt = Number.isInteger(n);
  const round = (v: number) => (isInt ? Math.round(v) : Math.round(v * 100) / 100);

  const candidates: DistractorSuggestion[] = ([
    {
      label: 'Sign error',
      category: 'sign_error',
      value: String(round(-n)),
      rationale: 'Results from dropping or flipping a negative sign during the final step — one of the most common Digital SAT slip-ups.'
    },
    {
      label: 'Arithmetic slip',
      category: 'arithmetic',
      value: String(round(n + (n === 0 ? 1 : Math.sign(n)))),
      rationale: 'Off-by-one style arithmetic mistake (e.g. a miscounted addition/subtraction in the last step).'
    },
    {
      label: 'Partially correct ("half-right") reasoning',
      category: 'partial_reasoning',
      value: String(round(n / 2)),
      rationale: 'Represents stopping halfway through a multi-step process (e.g. solving for 2x but reporting it as x).'
    },
    {
      label: 'Incorrect algebraic manipulation',
      category: 'algebraic_manipulation',
      value: String(round(n * 2)),
      rationale: 'Represents a doubling-style error, such as forgetting to divide both sides by a coefficient.'
    },
    {
      label: 'Common SAT trap',
      category: 'sat_trap',
      value: String(round(n + 1)),
      rationale: 'A near-miss value close enough to the correct answer to catch students who make a small rounding or estimation error.'
    }
  ] as DistractorSuggestion[]).filter((c) => c.value !== String(round(n)) && c.value !== correctValue);

  // Deduplicate by value, keep at most 4 so validators aren't overwhelmed
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.value)) return false;
    seen.add(c.value);
    return true;
  }).slice(0, 4);
}

function toNumber(s: string | undefined | null): number | null {
  if (!s) return null;
  const cleaned = s.trim().replace(/[$,]/g, '').replace(/\s*(units|percent|%)\s*$/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}