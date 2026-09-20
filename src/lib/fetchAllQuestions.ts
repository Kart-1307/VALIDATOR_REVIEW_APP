import { supabase } from './supabaseClient';
import { rowToQuestion, QuestionRow } from './mappers';
import type { SATQuestion } from '../types';

// Reads every row of a questions table with a stable order (created_at alone is
// not unique for bulk-inserted rows, so id breaks ties). Pages are advanced by
// the number of rows actually returned, so a server-side max-rows cap below
// `pageSize` cannot silently truncate the result. Throws on any read error.
export async function fetchAllQuestions<R extends QuestionRow = QuestionRow>(
  table: string,
  mapRow: (row: R) => SATQuestion = rowToQuestion as unknown as (row: R) => SATQuestion,
  pageSize = 1000
): Promise<SATQuestion[]> {
  const out: SATQuestion[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as R[]).map(mapRow));
    from += data.length;
  }
  return out;
}
