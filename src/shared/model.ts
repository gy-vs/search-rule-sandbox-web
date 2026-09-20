// Shared domain model for the search rule workbench.
// Used by both the server (compile/simulate) and the client (editor),
// so types and hashing stay in sync.

export type RuleKind = 'rewrite' | 'pin' | 'demote';

export type MatchSpec =
  | {type: 'exact'; value: string; caseSensitive?: boolean}
  | {type: 'prefix'; value: string; caseSensitive?: boolean}
  | {type: 'regex'; pattern: string; flags?: string};

export type Rule = {
  id: string;
  kind: RuleKind;
  enabled: boolean;
  /** Higher priority is evaluated first and wins conflicts. */
  priority: number;
  /**
   * '/'-separated scope path. 'all' matches every query scope;
   * 'web' matches queries scoped 'web' and 'web/mobile', etc.
   */
  scope: string;
  match: MatchSpec;
  /** rewrite: replacement text; regex matches may use $1..$9 group refs. */
  replacement?: string;
  /** pin: doc ids lifted to the top, in listed order. */
  pins?: string[];
  /** demote: doc ids whose score is multiplied by demoteFactor. */
  demoteDocIds?: string[];
  demoteFactor?: number;
};

export type SampleQuery = {
  id: string;
  text: string;
  scope?: string;
  /** Hard filters, e.g. {category: 'news'} — pinned docs that violate them conflict. */
  filters?: Record<string, string>;
};

export type Diagnostic =
  | {code: 'invalid_regex'; ruleId: string; message: string}
  | {code: 'unreachable'; ruleId: string; shadowedBy: string; message: string}
  | {code: 'override_conflict'; ruleIds: [string, string]; winner: string; message: string}
  | {code: 'rewrite_loop'; ruleIds: string[]; message: string}
  | {code: 'duplicate_effect'; ruleId: string; shadowedBy: string; message: string};

export type ChainEvent = {
  seq: number;
  ruleId: string | null;
  kind:
    | 'rewrite'
    | 'rewrite_noop'
    | 'pin'
    | 'pin_filtered'
    | 'pin_unknown_doc'
    | 'demote'
    | 'filter';
  message: string;
  before?: string;
  after?: string;
  docId?: string;
};

export type ResultDoc = {
  docId: string;
  title: string;
  category: string;
  score: number;
  pinned: boolean;
  demoted: boolean;
  /** Rule responsible for the pin/demote, so the UI can trace back to it. */
  viaRuleId?: string;
};

export type SampleResult = {
  sampleId: string;
  status: 'ok' | 'error';
  error?: {code: string; message: string};
  finalQuery?: string;
  results?: ResultDoc[];
  chain: ChainEvent[];
};

export type SimulationResponse = {
  draftHash: string;
  diagnostics: Diagnostic[];
  results: SampleResult[];
};

export type ExperimentRow = {
  id: string;
  name: string;
  revision: number;
  rules: Rule[];
  samples: SampleQuery[];
  updatedAt: string;
};

export type ExperimentSummary = Omit<ExperimentRow, 'rules' | 'samples'>;
