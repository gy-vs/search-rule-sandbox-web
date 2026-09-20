import {useEffect, useMemo, useState} from 'react';
import {AlertTriangle, ArrowDown, ArrowUp, FlaskConical, GitCompareArrows, Play, Plus, RotateCcw, Save, Trash2} from 'lucide-react';
import type {ChainEvent, Diagnostic, ExperimentRow, ExperimentSummary, MatchSpec, Rule, RuleKind, SampleQuery, SimulationResponse} from '../shared/model';
import {canonicalize, draftHash} from '../shared/drafthash';

const KINDS: RuleKind[] = ['rewrite', 'pin', 'demote'];

function patchMatch(match: MatchSpec, text: string): MatchSpec {
  return match.type === 'regex' ? {...match, pattern: text} : {...match, value: text};
}

function makeRule(kind: RuleKind): Rule {
  const id = 'r-' + Math.random().toString(36).slice(2, 8);
  const base: Rule = {id, kind, enabled: true, priority: 10, scope: 'all', match: {type: 'exact', value: ''}};
  if (kind === 'rewrite') base.replacement = '';
  if (kind === 'pin') base.pins = [];
  if (kind === 'demote') {
    base.demoteDocIds = [];
    base.demoteFactor = 0.5;
  }
  return base;
}

function sortForDisplay(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
}

function formatFilters(filters?: Record<string, string>): string {
  return Object.entries(filters ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function parseFilters(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of text.split(',')) {
    const [key, value] = pair.split('=').map((part) => part.trim());
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseIdList(text: string): string[] {
  return text.split(',').map((part) => part.trim()).filter(Boolean);
}

function diagnosticRuleIds(diagnostic: Diagnostic): string[] {
  if ('ruleId' in diagnostic) return [diagnostic.ruleId];
  return diagnostic.ruleIds;
}

export default function App() {
  const [items, setItems] = useState<ExperimentSummary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [saved, setSaved] = useState<ExperimentRow | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [samples, setSamples] = useState<SampleQuery[]>([]);
  const [sim, setSim] = useState<SimulationResponse | null>(null);
  const [status, setStatus] = useState('Ready');
  const [conflict, setConflict] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    fetch('/api/experiments').then((res) => res.json()).then(setItems);
  }, []);

  function load(id: string) {
    setStatus('Loading');
    setSim(null);
    setConflict(false);
    setHighlight(null);
    fetch('/api/experiments/' + id)
      .then((res) => res.json())
      .then((row: ExperimentRow) => {
        setSaved(row);
        setRules(row.rules);
        setSamples(row.samples);
        setStatus('Ready');
      });
  }

  useEffect(() => load(selected), [selected]);

  const currentHash = useMemo(() => draftHash({rules, samples}), [rules, samples]);
  const dirty = saved !== null && draftHash({rules: saved.rules, samples: saved.samples}) !== currentHash;
  // Results are bound to the draft they were simulated from; once the draft
  // moves on, they are stale and must not be read as describing the editor.
  const stale = sim !== null && sim.draftHash !== currentHash;

  const diff = useMemo(() => {
    if (!saved) return null;
    const savedById = new Map(saved.rules.map((rule) => [rule.id, rule]));
    const draftIds = new Set(rules.map((rule) => rule.id));
    return {
      added: rules.filter((rule) => !savedById.has(rule.id)),
      removed: saved.rules.filter((rule) => !draftIds.has(rule.id)),
      changed: rules.filter((rule) => savedById.has(rule.id) && canonicalize(rule) !== canonicalize(savedById.get(rule.id))),
      samplesChanged: canonicalize(samples) !== canonicalize(saved.samples),
    };
  }, [rules, samples, saved]);

  function updateRule(id: string, patch: Partial<Rule>) {
    setRules((prev) => prev.map((rule) => (rule.id === id ? {...rule, ...patch} : rule)));
  }

  function moveRule(id: string, dir: -1 | 1) {
    const sorted = sortForDisplay(rules);
    const index = sorted.findIndex((rule) => rule.id === id);
    const neighbor = sorted[index + dir];
    if (!neighbor) return;
    const mine = sorted[index];
    setRules((prev) =>
      prev.map((rule) => {
        if (rule.id === mine.id) return {...rule, priority: mine.priority === neighbor.priority ? neighbor.priority - dir : neighbor.priority};
        if (rule.id === neighbor.id) return {...rule, priority: mine.priority === neighbor.priority ? mine.priority + dir : mine.priority};
        return rule;
      }),
    );
  }

  function updateSample(id: string, patch: Partial<SampleQuery>) {
    setSamples((prev) => prev.map((sample) => (sample.id === id ? {...sample, ...patch} : sample)));
  }

  async function save() {
    if (!saved) return;
    setStatus('Saving');
    const response = await fetch('/api/experiments/' + saved.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision: saved.revision, rules, samples}),
    });
    const body = await response.json();
    if (response.status === 409) {
      setConflict(true);
      setStatus('Revision conflict');
      return;
    }
    if (!response.ok) {
      setStatus('Save rejected: ' + (body.errors?.join('; ') ?? body.error ?? response.status));
      return;
    }
    setSaved(body);
    setConflict(false);
    setItems((prev) => prev.map((item) => (item.id === body.id ? {...item, revision: body.revision, updatedAt: body.updatedAt} : item)));
    setStatus('Saved');
  }

  async function simulate() {
    if (!saved) return;
    const draft = {rules, samples};
    const hash = draftHash(draft);
    setStatus('Simulating');
    const response = await fetch('/api/experiments/' + saved.id + '/simulate', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...draft, draftHash: hash}),
    });
    const body = await response.json();
    if (!response.ok) {
      setStatus(body.error === 'draft_hash_mismatch' ? 'Draft changed mid-simulation — run again' : 'Simulation rejected');
      return;
    }
    // Even if the user kept editing while the request was in flight, storing
    // the echoed hash is safe: the stale check above hides outdated results.
    setSim(body);
    setStatus('Ready');
  }

  function trace(ruleId: string) {
    setHighlight(ruleId);
    document.getElementById('rule-' + ruleId)?.scrollIntoView({behavior: 'smooth', block: 'center'});
  }

  const ordered = sortForDisplay(rules);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Search Rule Workbench</strong>
        <small>Experiment-only — production search is never affected</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Experiments</h2>
          <div className="list">
            {items.map((item) => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}
                <br />
                <small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
          <h2>Draft</h2>
          <p className="hash">
            hash <code>{currentHash}</code>
          </p>
          <p>{dirty ? 'Unsaved changes' : 'Matches saved revision'}</p>
          {sim && (
            <p className="hash">
              simulated <code className={stale ? 'stale-hash' : ''}>{sim.draftHash}</code>
            </p>
          )}
        </aside>

        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save} disabled={!saved}>
              <Save size={15} />
              Save
            </button>
            <button onClick={simulate} disabled={!saved}>
              <Play size={15} />
              Simulate
            </button>
            <button onClick={() => setShowDiff((value) => !value)} disabled={!saved}>
              <GitCompareArrows size={15} />
              {showDiff ? 'Hide diff' : 'Diff vs saved'}
            </button>
            <span className="status">{status}</span>
          </div>

          {conflict && (
            <div className="banner conflict">
              <AlertTriangle size={14} /> Saved revision moved on — someone else saved first.
              <button onClick={() => load(selected)}>
                <RotateCcw size={13} /> Reload latest
              </button>
            </div>
          )}

          {showDiff && diff && saved && (
            <section className="diff">
              <h3>Draft vs saved revision {saved.revision}</h3>
              {!dirty && <p>No changes.</p>}
              {diff.added.map((rule) => (
                <div className="diff-added" key={rule.id}>
                  + {rule.id} <small>{rule.kind}</small>
                </div>
              ))}
              {diff.removed.map((rule) => (
                <div className="diff-removed" key={rule.id}>
                  − {rule.id} <small>{rule.kind}</small>
                </div>
              ))}
              {diff.changed.map((rule) => (
                <div className="diff-changed" key={rule.id}>
                  ~ {rule.id} <small>{rule.kind}</small>
                </div>
              ))}
              {diff.samplesChanged && <div className="diff-changed">~ sample queries changed</div>}
            </section>
          )}

          <h2>
            Rewrite / pin / demote rules
            <button className="icon" title="Add rule" onClick={() => setRules((prev) => [...prev, makeRule('rewrite')])}>
              <Plus size={15} />
            </button>
          </h2>
          <div className="rules">
            {ordered.map((rule, index) => (
              <div className={'rule' + (highlight === rule.id ? ' highlighted' : '') + (rule.enabled ? '' : ' disabled')} id={'rule-' + rule.id} key={rule.id}>
                <div className="rule-head">
                  <input type="checkbox" checked={rule.enabled} title="Enabled" onChange={(event) => updateRule(rule.id, {enabled: event.target.checked})} />
                  <select value={rule.kind} onChange={(event) => updateRule(rule.id, {kind: event.target.value as RuleKind})}>
                    {KINDS.map((kind) => (
                      <option key={kind}>{kind}</option>
                    ))}
                  </select>
                  <code>{rule.id}</code>
                  <label>
                    prio
                    <input type="number" value={rule.priority} onChange={(event) => updateRule(rule.id, {priority: event.target.valueAsNumber || 0})} />
                  </label>
                  <label>
                    scope
                    <input type="text" value={rule.scope} onChange={(event) => updateRule(rule.id, {scope: event.target.value || 'all'})} />
                  </label>
                  <span className="rule-actions">
                    <button className="icon" title="Move up" disabled={index === 0} onClick={() => moveRule(rule.id, -1)}>
                      <ArrowUp size={14} />
                    </button>
                    <button className="icon" title="Move down" disabled={index === ordered.length - 1} onClick={() => moveRule(rule.id, 1)}>
                      <ArrowDown size={14} />
                    </button>
                    <button className="icon" title="Delete" onClick={() => setRules((prev) => prev.filter((candidate) => candidate.id !== rule.id))}>
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
                <div className="rule-body">
                  <select
                    value={rule.match.type}
                    onChange={(event) => {
                      const type = event.target.value as Rule['match']['type'];
                      updateRule(rule.id, {match: type === 'regex' ? {type, pattern: ''} : {type, value: ''}});
                    }}
                  >
                    <option value="exact">exact</option>
                    <option value="prefix">prefix</option>
                    <option value="regex">regex</option>
                  </select>
                  {rule.match.type === 'regex' ? (
                    <input type="text" placeholder="pattern" value={rule.match.pattern} onChange={(event) => updateRule(rule.id, {match: patchMatch(rule.match, event.target.value)})} />
                  ) : (
                    <input type="text" placeholder="query text" value={rule.match.value} onChange={(event) => updateRule(rule.id, {match: patchMatch(rule.match, event.target.value)})} />
                  )}
                  {rule.kind === 'rewrite' && (
                    <input type="text" placeholder="replacement" value={rule.replacement ?? ''} onChange={(event) => updateRule(rule.id, {replacement: event.target.value})} />
                  )}
                  {rule.kind === 'pin' && (
                    <input
                      type="text"
                      placeholder="pin doc ids, comma separated"
                      defaultValue={(rule.pins ?? []).join(', ')}
                      onBlur={(event) => updateRule(rule.id, {pins: parseIdList(event.target.value)})}
                    />
                  )}
                  {rule.kind === 'demote' && (
                    <>
                      <input
                        type="text"
                        placeholder="demote doc ids"
                        defaultValue={(rule.demoteDocIds ?? []).join(', ')}
                        onBlur={(event) => updateRule(rule.id, {demoteDocIds: parseIdList(event.target.value)})}
                      />
                      <label>
                        factor
                        <input type="number" step="0.1" min="0" value={rule.demoteFactor ?? 0.5} onChange={(event) => updateRule(rule.id, {demoteFactor: event.target.valueAsNumber || 0.5})} />
                      </label>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          <h2>
            Sample queries
            <button className="icon" title="Add sample" onClick={() => setSamples((prev) => [...prev, {id: 's' + (prev.length + 1), text: ''}])}>
              <Plus size={15} />
            </button>
          </h2>
          <div className="samples">
            {samples.map((sample) => (
              <div className="sample" key={sample.id}>
                <code>{sample.id}</code>
                <input type="text" placeholder="query text" value={sample.text} onChange={(event) => updateSample(sample.id, {text: event.target.value})} />
                <input type="text" placeholder="scope (default all)" value={sample.scope ?? ''} onChange={(event) => updateSample(sample.id, {scope: event.target.value || undefined})} />
                <input
                  type="text"
                  placeholder="filters e.g. category=news"
                  defaultValue={formatFilters(sample.filters)}
                  onBlur={(event) => updateSample(sample.id, {filters: parseFilters(event.target.value)})}
                />
                <button className="icon" title="Delete" onClick={() => setSamples((prev) => prev.filter((candidate) => candidate.id !== sample.id))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <aside className="pane">
          <h2>Simulation</h2>
          {!sim && <p>Run Simulate to compile the draft and dry-run every sample query.</p>}
          {sim && stale && (
            <div className="banner stale">
              <AlertTriangle size={14} /> Draft changed since this run — these results belong to an older draft and will not be applied. Simulate again.
            </div>
          )}
          {sim && !stale && sim.diagnostics.length > 0 && (
            <section className="diagnostics">
              <h3>Compile diagnostics</h3>
              {sim.diagnostics.map((diagnostic, index) => (
                <div className={'diag diag-' + diagnostic.code} key={index}>
                  <code>{diagnostic.code}</code> {diagnostic.message}
                  <span className="trace-links">
                    {diagnosticRuleIds(diagnostic).map((ruleId) => (
                      <button className="link" key={ruleId} onClick={() => trace(ruleId)}>
                        → {ruleId}
                      </button>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          )}
          {sim && (
            <div className={stale ? 'results stale' : 'results'}>
              {sim.results.map((result) => (
                <section className="sample-result" key={result.sampleId}>
                  <h3>
                    {result.sampleId}{' '}
                    <span className={result.status === 'ok' ? 'pill ok' : 'pill err'}>{result.status}</span>
                  </h3>
                  {result.status === 'error' && <p className="error">{result.error?.message}</p>}
                  {result.finalQuery !== undefined && (
                    <p>
                      final query: <code>{result.finalQuery}</code>
                    </p>
                  )}
                  {result.results && (
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>doc</th>
                          <th>score</th>
                          <th>flags</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.results.map((doc, index) => (
                          <tr key={doc.docId}>
                            <td>{index + 1}</td>
                            <td>
                              <code>{doc.docId}</code> {doc.title}
                            </td>
                            <td>{doc.score}</td>
                            <td>
                              {doc.pinned && <span className="pill pin">pinned</span>}
                              {doc.demoted && <span className="pill demote">demoted</span>}
                              {doc.viaRuleId && (
                                <button className="link" onClick={() => trace(doc.viaRuleId!)}>
                                  → {doc.viaRuleId}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {result.chain.length > 0 && (
                    <details open={result.status === 'error'}>
                      <summary>Decision chain ({result.chain.length})</summary>
                      <ol className="chain">
                        {result.chain.map((event: ChainEvent) => (
                          <li key={event.seq} className={'ev-' + event.kind}>
                            <span className="seq">{event.seq}</span> {event.message}
                            {event.ruleId && (
                              <button className="link" onClick={() => trace(event.ruleId!)}>
                                → {event.ruleId}
                              </button>
                            )}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </section>
              ))}
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
