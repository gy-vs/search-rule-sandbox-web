// Domain types shared by server and client.

export type RuleKind = 'rewrite' | 'pin' | 'demote';
export type MatchType = 'exact' | 'regex';
export type DemoteAction = 'filter' | 'downweight';

/** '*' means the rule applies in every search scope. */
export type Scope = string;

export interface Rule {
  id: string;
  kind: RuleKind;
  matchType: MatchType;
  pattern: string;
  scope: Scope;
  /** Higher priority wins. Ties: exact before regex, then authoring order. */
  priority: number;
  enabled: boolean;
  /** Rewrite: replacement string, regex capture groups like $1 are supported. */
  replacement?: string;
  /** Rewrite regex only: case-insensitive flag. */
  ignoreCase?: boolean;
  /** Pin: document to pin. */
  docId?: string;
  /** Pin: 1-based slot; lower slots come first. */
  position?: number;
  /** Demote: single target document. */
  /** Demote: remove matched documents. */
  action?: DemoteAction;
  /** Demote downweight: score multiplier in [0, 1). */
  factor?: number;
  /** Demote: regex matched against document id/title. */
  docPattern?: string;
}

export interface SampleQuery {
  id: string;
  text: string;
  scope: string;
}

export interface ExperimentDraft {
  rules: Rule[];
  samples: SampleQuery[];
}

export interface Experiment extends ExperimentDraft {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  ruleId?: string;
  otherRuleId?: string;
  sampleId?: string;
}

export type ChainStepType =
  | 'rewrite'
  | 'rewrite-loop'
  | 'rewrite-limit'
  | 'pin'
  | 'pin-ignored'
  | 'filter'
  | 'downweight'
  | 'conflict'
  | 'organic';

export interface ChainStep {
  index: number;
  type: ChainStepType;
  ruleId?: string;
  otherRuleId?: string;
  iteration?: number;
  /** Query evaluated by this step. */
  query?: string;
  /** Rewrite input / output. */
  input?: string;
  output?: string;
  /** Rewrite loop: rule ids forming the cycle. */
  cycle?: string[];
  docId?: string;
  docIds?: string[];
  position?: number;
  factor?: number;
  /** 'filter_wins' | 'pin_wins' for conflicts; ignore reasons otherwise. */
  outcome?: string;
  reason?: string;
}

export interface RankedDoc {
  docId: string;
  title: string;
  score: number;
  /** Rule ids that explain why this document is where it is. */
  ruleIds: string[];
}

export interface ResultEntry {
  docId: string;
  title: string;
  score: number;
  basis: 'pin' | 'organic';
  ruleIds: string[];
}

export interface SampleResult {
  sampleId: string;
  ok: boolean;
  error?: string;
  scope: string;
  originalQuery: string;
  finalQuery: string;
  chain: ChainStep[];
  pinned: RankedDoc[];
  organic: RankedDoc[];
  results: ResultEntry[];
  diagnostics: Diagnostic[];
}

export interface SimulationResponse {
  draftHash: string;
  diagnostics: Diagnostic[];
  /** Rule ids in compiled order (scope/priority/type/authoring). */
  compiledOrder: string[];
  results: SampleResult[];
}

export interface Doc {
  id: string;
  title: string;
  scopes: string[];
}
