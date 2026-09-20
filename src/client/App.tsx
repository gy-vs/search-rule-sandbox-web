import {useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction} from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  FlaskConical,
  GitCompare,
  ListChecks,
  Play,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ChainStep,
  Diagnostic,
  Experiment,
  Rule,
  SampleQuery,
  SampleResult,
  SimulationResponse,
} from '../shared/types';
import {diffList} from './lib/diff';
import {computeDraftHash, shortHash} from './lib/hash';

type ExperimentSummary = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  ruleCount: number;
  sampleCount: number;
  draftHash: string;
};
type SavedExperiment = Experiment & {draftHash: string};
type Draft = {rules: Rule[]; samples: SampleQuery[]};
type SimState =
  | {status: 'idle'}
  | {status: 'loading'}
  | {status: 'ready'; data: SimulationResponse; boundHash: string}
  | {status: 'error'; message: string};

type EditorTab = 'rules' | 'samples';
type RightTab = 'simulate' | 'diff' | 'diagnostics';

let tempCounter = 0;
function newRuleId(kind: string) {
  tempCounter += 1;
  return `new-${kind}-${Date.now().toString(36)}-${tempCounter}`;
}

function emptyRule(kind: Rule['kind']): Rule {
  const base: Rule = {
    id: newRuleId(kind),
    kind,
    matchType: 'exact',
    pattern: '',
    scope: '*',
    priority: 0,
    enabled: true,
  };
  if (kind === 'rewrite') return {...base, replacement: '', ignoreCase: false};
  if (kind === 'pin') return {...base, docId: '', position: 1};
  return {...base, action: 'filter', docId: '', factor: 0.3};
}

const FIELD_LABELS: Record<string, string> = {
  kind: '类型',
  matchType: '匹配',
  pattern: '模式',
  scope: '作用域',
  priority: '优先级',
  enabled: '启用',
  replacement: '替换为',
  ignoreCase: '忽略大小写',
  docId: '文档',
  position: '坑位',
  action: '动作',
  factor: '系数',
  docPattern: '文档匹配',
};

function fieldValue(value: unknown): string {
  if (value === undefined) return '∅';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function App() {
  const [items, setItems] = useState<ExperimentSummary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [saved, setSaved] = useState<SavedExperiment | null>(null);
  const [draft, setDraft] = useState<Draft>({rules: [], samples: []});
  const [draftHash, setDraftHash] = useState('');
  const [editorTab, setEditorTab] = useState<EditorTab>('rules');
  const [rightTab, setRightTab] = useState<RightTab>('simulate');
  const [sim, setSim] = useState<SimState>({status: 'idle'});
  const [saveConflict, setSaveConflict] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState('Ready');
  const [highlightRule, setHighlightRule] = useState<string | null>(null);
  const [openChain, setOpenChain] = useState<Record<string, boolean>>({});

  const simSeq = useRef(0);
  const draftHashRef = useRef('');
  draftHashRef.current = draftHash;

  useEffect(() => {
    fetch('/api/experiments')
      .then((r) => r.json())
      .then(setItems);
  }, []);

  useEffect(() => {
    setStatusLine('Loading');
    setSaveConflict(null);
    setSim({status: 'idle'});
    fetch('/api/experiments/' + selected)
      .then((r) => r.json())
      .then((value: SavedExperiment) => {
        setSaved(value);
        setDraft({rules: structuredClone(value.rules), samples: structuredClone(value.samples)});
        setStatusLine('Loaded revision ' + value.revision);
      });
  }, [selected]);

  // Recompute the draft hash whenever the draft changes.
  useEffect(() => {
    let cancelled = false;
    computeDraftHash(draft).then((hash) => {
      if (!cancelled) setDraftHash(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [draft]);

  const isClean = saved !== null && draftHash !== '' && draftHash === saved.draftHash;

  const updateRule = useCallback((id: string, patch: Partial<Rule>) => {
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((rule) => (rule.id === id ? {...rule, ...patch} : rule)),
    }));
  }, []);

  const moveRule = useCallback((id: string, delta: -1 | 1) => {
    setDraft((current) => {
      const index = current.rules.findIndex((rule) => rule.id === id);
      const next = index + delta;
      if (index < 0 || next < 0 || next >= current.rules.length) return current;
      const rules = [...current.rules];
      [rules[index], rules[next]] = [rules[next], rules[index]];
      return {...current, rules};
    });
  }, []);

  const removeRule = useCallback((id: string) => {
    setDraft((current) => ({...current, rules: current.rules.filter((rule) => rule.id !== id)}));
  }, []);

  const addRule = useCallback((kind: Rule['kind']) => {
    const rule = emptyRule(kind);
    setDraft((current) => ({...current, rules: [...current.rules, rule]}));
    setEditorTab('rules');
    setHighlightRule(rule.id);
  }, []);

  const updateSample = useCallback((id: string, patch: Partial<SampleQuery>) => {
    setDraft((current) => ({
      ...current,
      samples: current.samples.map((sample) => (sample.id === id ? {...sample, ...patch} : sample)),
    }));
  }, []);

  const addSample = useCallback(() => {
    tempCounter += 1;
    const sample: SampleQuery = {id: `new-sample-${Date.now().toString(36)}-${tempCounter}`, text: '', scope: 'web'};
    setDraft((current) => ({...current, samples: [...current.samples, sample]}));
  }, []);

  const removeSample = useCallback((id: string) => {
    setDraft((current) => ({...current, samples: current.samples.filter((sample) => sample.id !== id)}));
  }, []);

  const jumpToRule = useCallback(
    (ruleId: string | undefined) => {
      if (!ruleId) return;
      setEditorTab('rules');
      setRightTab('simulate');
      setHighlightRule(ruleId);
      requestAnimationFrame(() => {
        document.getElementById('rule-' + ruleId)?.scrollIntoView({behavior: 'smooth', block: 'center'});
      });
    },
    [],
  );

  const simulateDraft = useCallback(async () => {
    if (!saved) return;
    const seq = ++simSeq.current;
    const hash = draftHashRef.current;
    setSim({status: 'loading'});
    setStatusLine('Simulating draft ' + shortHash(hash));
    try {
      const response = await fetch(`/api/experiments/${saved.id}/simulate`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({rules: draft.rules, samples: draft.samples, draftHash: hash}),
      });
      // A newer edit superseded this request — its results must not render.
      if (seq !== simSeq.current) return;
      const data = await response.json();
      if (!response.ok) {
        setSim({status: 'error', message: data.message ?? `HTTP ${response.status}: ${data.error}`});
        setStatusLine('Simulation rejected');
        return;
      }
      // Double bind check on the client: old results never apply to a new draft.
      if (data.draftHash !== draftHashRef.current) {
        setSim({status: 'error', message: '模拟结果属于旧草稿，已丢弃，请重新运行。'});
        setStatusLine('Stale simulation discarded');
        return;
      }
      setSim({status: 'ready', data, boundHash: hash});
      setStatusLine('Simulated draft ' + shortHash(hash));
    } catch (error) {
      if (seq !== simSeq.current) return;
      setSim({status: 'error', message: (error as Error).message});
      setStatusLine('Simulation failed');
    }
  }, [draft, saved]);

  // Any edit invalidates simulation results bound to a previous draft hash.
  useEffect(() => {
    setSim((current) =>
      current.status === 'ready' && current.boundHash !== draftHashRef.current ? {status: 'idle'} : current,
    );
    simSeq.current += 1;
  }, [draft]);

  const saveDraft = useCallback(async () => {
    if (!saved) return;
    setStatusLine('Saving revision ' + (saved.revision + 1));
    setSaveConflict(null);
    try {
      const response = await fetch('/api/experiments/' + saved.id, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({rules: draft.rules, samples: draft.samples, revision: saved.revision}),
      });
      const data = await response.json();
      if (response.status === 409) {
        setSaveConflict(`已被其他编辑保存为 revision ${data.current?.revision ?? '?'}，当前草稿保留未动。`);
        setStatusLine('Revision conflict');
        return;
      }
      if (!response.ok) {
        setStatusLine('Save failed: ' + (data.error ?? response.status));
        return;
      }
      setSaved(data);
      setDraft({rules: structuredClone(data.rules), samples: structuredClone(data.samples)});
      setItems((current) =>
        current.map((item) =>
          item.id === data.id
            ? {...item, revision: data.revision, ruleCount: data.rules.length, sampleCount: data.samples.length, draftHash: data.draftHash}
            : item,
        ),
      );
      setStatusLine('Saved revision ' + data.revision);
    } catch (error) {
      setStatusLine('Save failed: ' + (error as Error).message);
    }
  }, [draft, saved]);

  const reloadSaved = useCallback(() => {
    if (!saveConflict || !saved) return;
    fetch('/api/experiments/' + selected)
      .then((r) => r.json())
      .then((value: SavedExperiment) => {
        setSaved(value);
        setDraft({rules: structuredClone(value.rules), samples: structuredClone(value.samples)});
        setSaveConflict(null);
        setStatusLine('Loaded revision ' + value.revision);
      });
  }, [saveConflict, saved, selected]);

  const rulesDiff = useMemo(() => diffList(saved?.rules ?? [], draft.rules), [saved, draft.rules]);
  const samplesDiff = useMemo(() => diffList(saved?.samples ?? [], draft.samples), [saved, draft.samples]);
  const simDiagnostics = sim.status === 'ready' ? sim.data.diagnostics : [];

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Search Relevance Lab</strong>
        <small>实验工作台 · 规则仅在实验内生效</small>
      </header>

      <section className="workspace">
        <aside className="pane">
          <h2>实验</h2>
          <div className="list">
            {items.map((item) => (
              <button
                className={item.id === selected ? 'active' : ''}
                onClick={() => setSelected(item.id)}
                key={item.id}
              >
                {item.name}
                <br />
                <small>
                  revision {item.revision} · {item.ruleCount} 规则 · {item.sampleCount} 样例 ·{' '}
                  <span title="已保存草稿哈希">{shortHash(item.draftHash)}</span>
                </small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane editor-pane">
          <div className="toolbar">
            <button className="primary" onClick={saveDraft} disabled={isClean || !saved}>
              <Save size={15} />
              保存
            </button>
            <button onClick={simulateDraft} disabled={!saved}>
              <Play size={15} />
              模拟
            </button>
            <span className={'hash-chip ' + (isClean ? 'clean' : 'dirty')}>
              {isClean ? <Check size={13} /> : <AlertTriangle size={13} />}
              草稿 {shortHash(draftHash)} · 已保存 {saved ? shortHash(saved.draftHash) : '—'}
            </span>
            <span className="status-line">{statusLine}</span>
          </div>

          {saveConflict && (
            <div className="banner conflict" role="alert">
              <AlertTriangle size={16} />
              <span>{saveConflict}</span>
              <button onClick={reloadSaved}>载入最新版本（覆盖草稿）</button>
              <button onClick={() => setSaveConflict(null)} aria-label="关闭">
                <X size={14} />
              </button>
            </div>
          )}

          <div className="subtabs">
            <button className={editorTab === 'rules' ? 'active' : ''} onClick={() => setEditorTab('rules')}>
              <ListChecks size={14} /> 规则 ({draft.rules.length})
            </button>
            <button className={editorTab === 'samples' ? 'active' : ''} onClick={() => setEditorTab('samples')}>
              样例查询 ({draft.samples.length})
            </button>
          </div>

          {editorTab === 'rules' && (
            <div>
              <div className="toolbar compact">
                <button onClick={() => addRule('rewrite')}>
                  <Plus size={14} /> 重写
                </button>
                <button onClick={() => addRule('pin')}>
                  <Plus size={14} /> 固定
                </button>
                <button onClick={() => addRule('demote')}>
                  <Plus size={14} /> 降权/过滤
                </button>
                <small className="hint">同优先级：精确 &gt; 正则；并列时按列表顺序。↑↓ 可调序。</small>
              </div>
              <div className="rule-list">
                {draft.rules.map((rule, index) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    index={index}
                    total={draft.rules.length}
                    highlighted={highlightRule === rule.id}
                    onChange={(patch) => updateRule(rule.id, patch)}
                    onMove={(delta) => moveRule(rule.id, delta)}
                    onRemove={() => removeRule(rule.id)}
                    onClearHighlight={() => setHighlightRule(null)}
                  />
                ))}
                {draft.rules.length === 0 && <p className="hint">还没有规则，点击上方按钮添加。</p>}
              </div>
            </div>
          )}

          {editorTab === 'samples' && (
            <div>
              <div className="toolbar compact">
                <button onClick={addSample}>
                  <Plus size={14} /> 添加样例
                </button>
              </div>
              <div className="sample-list">
                {draft.samples.map((sample) => (
                  <div className="sample-row" key={sample.id}>
                    <code className="sample-id">{sample.id}</code>
                    <input
                      aria-label="样例查询文本"
                      placeholder="查询文本"
                      value={sample.text}
                      onChange={(event) => updateSample(sample.id, {text: event.target.value})}
                    />
                    <input
                      aria-label="作用域"
                      className="scope-input"
                      placeholder="作用域"
                      value={sample.scope}
                      onChange={(event) => updateSample(sample.id, {scope: event.target.value})}
                    />
                    <button className="icon-btn" onClick={() => removeSample(sample.id)} aria-label="删除样例">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="pane right-pane">
          <div className="subtabs">
            <button className={rightTab === 'simulate' ? 'active' : ''} onClick={() => setRightTab('simulate')}>
              <Play size={14} /> 模拟
            </button>
            <button className={rightTab === 'diff' ? 'active' : ''} onClick={() => setRightTab('diff')}>
              <GitCompare size={14} /> 对比 rev{saved?.revision}
              {!rulesDiff.isEmpty || !samplesDiff.isEmpty ? <span className="dot" /> : null}
            </button>
            <button className={rightTab === 'diagnostics' ? 'active' : ''} onClick={() => setRightTab('diagnostics')}>
              <AlertTriangle size={14} /> 诊断
              {simDiagnostics.length > 0 ? <span className="badge-count">{simDiagnostics.length}</span> : null}
            </button>
          </div>

          {rightTab === 'simulate' && (
            <SimulationView sim={sim} openChain={openChain} setOpenChain={setOpenChain} onRuleClick={jumpToRule} />
          )}
          {rightTab === 'diff' && (
            <DiffView rulesDiff={rulesDiff} samplesDiff={samplesDiff} onRuleClick={jumpToRule} />
          )}
          {rightTab === 'diagnostics' && (
            <DiagnosticsView diagnostics={simDiagnostics} onRuleClick={jumpToRule} />
          )}
        </aside>
      </section>
    </main>
  );
}

function RuleCard(props: {
  rule: Rule;
  index: number;
  total: number;
  highlighted: boolean;
  onChange: (patch: Partial<Rule>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onClearHighlight: () => void;
}) {
  const {rule, onChange} = props;
  return (
    <div
      id={'rule-' + rule.id}
      className={'rule-card ' + (rule.enabled ? '' : 'disabled') + (props.highlighted ? ' highlighted' : '')}
      onAnimationEnd={props.onClearHighlight}
    >
      <div className="rule-head">
        <label className="enable-toggle" title="启用/停用">
          <input type="checkbox" checked={rule.enabled} onChange={(event) => onChange({enabled: event.target.checked})} />
        </label>
        <select value={rule.kind} onChange={(event) => onChange({kind: event.target.value as Rule['kind']})}>
          <option value="rewrite">重写 rewrite</option>
          <option value="pin">固定 pin</option>
          <option value="demote">降权 demote</option>
        </select>
        <code className="rule-id">{rule.id}</code>
        <span className="spacer" />
        <button className="icon-btn" disabled={props.index === 0} onClick={() => props.onMove(-1)} aria-label="上移">
          <ArrowUp size={14} />
        </button>
        <button
          className="icon-btn"
          disabled={props.index === props.total - 1}
          onClick={() => props.onMove(1)}
          aria-label="下移"
        >
          <ArrowDown size={14} />
        </button>
        <button className="icon-btn danger" onClick={props.onRemove} aria-label="删除规则">
          <Trash2 size={14} />
        </button>
      </div>
      <div className="rule-grid">
        <label>
          匹配
          <select value={rule.matchType} onChange={(event) => onChange({matchType: event.target.value as Rule['matchType']})}>
            <option value="exact">精确 exact</option>
            <option value="regex">正则 regex</option>
          </select>
        </label>
        <label>
          优先级
          <input
            type="number"
            value={rule.priority}
            onChange={(event) => onChange({priority: Number(event.target.value)})}
          />
        </label>
        <label className="wide">
          模式
          <input value={rule.pattern} placeholder={rule.matchType === 'regex' ? '^iphone.*pro$' : 'iphone 16'} onChange={(event) => onChange({pattern: event.target.value})} />
        </label>
        <label>
          作用域
          <input value={rule.scope} placeholder="* / shop / web" onChange={(event) => onChange({scope: event.target.value})} />
        </label>

        {rule.kind === 'rewrite' && (
          <>
            <label className="wide">
              替换为
              <input value={rule.replacement ?? ''} placeholder="$1 / 文本" onChange={(event) => onChange({replacement: event.target.value})} />
            </label>
            {rule.matchType === 'regex' && (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={!!rule.ignoreCase}
                  onChange={(event) => onChange({ignoreCase: event.target.checked})}
                />
                忽略大小写
              </label>
            )}
          </>
        )}

        {rule.kind === 'pin' && (
          <>
            <label className="wide">
              文档 ID
              <input value={rule.docId ?? ''} onChange={(event) => onChange({docId: event.target.value})} />
            </label>
            <label>
              坑位
              <input
                type="number"
                min={1}
                value={rule.position ?? 1}
                onChange={(event) => onChange({position: Number(event.target.value)})}
              />
            </label>
          </>
        )}

        {rule.kind === 'demote' && (
          <>
            <label>
              动作
              <select value={rule.action} onChange={(event) => onChange({action: event.target.value as Rule['action']})}>
                <option value="filter">过滤 filter</option>
                <option value="downweight">降权 downweight</option>
              </select>
            </label>
            <label className="wide">
              文档 ID（精确）
              <input value={rule.docId ?? ''} onChange={(event) => onChange({docId: event.target.value})} />
            </label>
            <label className="wide">
              文档匹配（正则，匹配 id 或标题）
              <input value={rule.docPattern ?? ''} placeholder="case" onChange={(event) => onChange({docPattern: event.target.value})} />
            </label>
            {rule.action === 'downweight' && (
              <label>
                系数 [0,1)
                <input
                  type="number"
                  step={0.05}
                  min={0}
                  max={0.999}
                  value={rule.factor ?? 0.3}
                  onChange={(event) => onChange({factor: Number(event.target.value)})}
                />
              </label>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RuleBadge({ruleId, onClick}: {ruleId: string; onClick: (id: string) => void}) {
  return (
    <button className="rule-badge" title={`回溯规则 ${ruleId}`} onClick={() => onClick(ruleId)}>
      {ruleId}
    </button>
  );
}

function chainDescription(step: ChainStep): string {
  switch (step.type) {
    case 'rewrite':
      return `迭代 ${step.iteration}: “${step.input}” → “${step.output}”`;
    case 'rewrite-loop':
      return `检测到重写循环: ${(step.cycle ?? []).join(' → ')}；停在 “${step.output}”`;
    case 'rewrite-limit':
      return '重写链达到最大迭代次数，强制停止';
    case 'pin':
      return `固定文档 ${step.docId} 到坑位 ${step.position}`;
    case 'pin-ignored':
      return `固定 ${step.docId ?? ''} 被忽略（${step.reason}）`;
    case 'filter':
      return `过滤移除: ${(step.docIds ?? []).join(', ')}`;
    case 'downweight':
      return `降权 ×${step.factor}: ${(step.docIds ?? []).join(', ')}`;
    case 'conflict':
      return step.outcome === 'filter_wins'
        ? `固定被过滤覆盖（filter 胜出）: 文档 ${step.docId}`
        : `降权对固定无效（pin 胜出）: 文档 ${step.docId}`;
    case 'organic':
      return `以 “${step.query}” 召回自然结果: ${(step.docIds ?? []).join(', ') || '（空）'}`;
  }
}

function SimulationView(props: {
  sim: SimState;
  openChain: Record<string, boolean>;
  setOpenChain: Dispatch<SetStateAction<Record<string, boolean>>>;
  onRuleClick: (id: string) => void;
}) {
  const {sim, onRuleClick} = props;
  if (sim.status === 'idle') {
    return <p className="hint">编辑后点击「模拟」。每次模拟绑定当前草稿哈希，草稿变更后旧结果自动失效。</p>;
  }
  if (sim.status === 'loading') return <p className="hint">模拟中…</p>;
  if (sim.status === 'error') return <div className="banner error">{sim.message}</div>;

  const {data, boundHash} = sim;
  const toggle = (sampleId: string) =>
    props.setOpenChain((current) => ({...current, [sampleId]: !current[sampleId]}));

  return (
    <div>
      <div className="sim-meta">
        绑定草稿 <code>{shortHash(boundHash)}</code> · 编译顺序 {data.compiledOrder.length} 条规则
        <div className="compiled-order">
          {data.compiledOrder.map((id) => (
            <RuleBadge key={id} ruleId={id} onClick={onRuleClick} />
          ))}
        </div>
      </div>
      {data.results.map((result) => (
        <SampleCard
          key={result.sampleId}
          result={result}
          open={!!props.openChain[result.sampleId]}
          onToggle={() => toggle(result.sampleId)}
          onRuleClick={onRuleClick}
        />
      ))}
    </div>
  );
}

function SampleCard(props: {
  result: SampleResult;
  open: boolean;
  onToggle: () => void;
  onRuleClick: (id: string) => void;
}) {
  const {result, onRuleClick} = props;
  if (!result.ok) {
    return (
      <div className="sample-card failed">
        <h4>
          <span className="status-dot failed" /> {result.sampleId}
        </h4>
        <div className="banner error">该样例模拟失败（不影响其它样例）: {result.error}</div>
      </div>
    );
  }
  const changed = result.finalQuery !== result.originalQuery;
  return (
    <div className="sample-card">
      <h4>
        <span className="status-dot ok" />
        {result.sampleId}
        <code className="scope-tag">{result.scope}</code>
      </h4>
      <div className="query-flow">
        <span>{result.originalQuery}</span>
        {changed && (
          <>
            <ArrowDown size={13} className="flow-arrow" />
            <strong>{result.finalQuery}</strong>
          </>
        )}
      </div>
      {result.diagnostics.length > 0 && (
        <div className="diag-list">
          {result.diagnostics.map((diagnostic, i) => (
            <div key={i} className={'diag-row ' + diagnostic.severity}>
              <DiagnosticRow diagnostic={diagnostic} onRuleClick={onRuleClick} />
            </div>
          ))}
        </div>
      )}
      <ol className="result-list">
        {result.results.map((entry, index) => (
          <li key={entry.docId} className={'result-row ' + entry.basis}>
            <span className="rank">{index + 1}</span>
            <span className="doc-title">{entry.title}</span>
            <code className="doc-id">{entry.docId}</code>
            <span className="doc-score">{entry.score.toFixed(2)}</span>
            <span className={'basis-tag ' + entry.basis}>{entry.basis === 'pin' ? '固定' : '自然'}</span>
            <span className="result-rules">
              {entry.ruleIds.map((id) => (
                <RuleBadge key={id} ruleId={id} onClick={onRuleClick} />
              ))}
            </span>
          </li>
        ))}
        {result.results.length === 0 && <li className="hint">无结果</li>}
      </ol>
      <button className="chain-toggle" onClick={props.onToggle}>
        {props.open ? '收起决策链' : `查看决策链（${result.chain.length} 步）`}
      </button>
      {props.open && (
        <ol className="chain-list">
          {result.chain.map((step) => (
            <li key={step.index} className={'chain-step ' + step.type}>
              <span className="chain-index">#{step.index}</span>
              <span className="chain-type">{step.type}</span>
              <span className="chain-text">{chainDescription(step)}</span>
              <span className="chain-rules">
                {step.ruleId ? <RuleBadge ruleId={step.ruleId} onClick={onRuleClick} /> : null}
                {step.otherRuleId ? <RuleBadge ruleId={step.otherRuleId} onClick={onRuleClick} /> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DiffView(props: {
  rulesDiff: ReturnType<typeof diffList>;
  samplesDiff: ReturnType<typeof diffList>;
  onRuleClick: (id: string) => void;
}) {
  const {rulesDiff, samplesDiff} = props;
  if (rulesDiff.isEmpty && samplesDiff.isEmpty) {
    return <p className="hint">草稿与已保存 revision 完全一致。</p>;
  }
  return (
    <div>
      <h4>规则</h4>
      {rulesDiff.entries
        .filter((entry) => entry.type !== 'unchanged')
        .map((entry) => {
          if (entry.type === 'added')
            return (
              <div className="diff-row added" key={'a' + entry.id}>
                <Plus size={14} /> 新增 <RuleBadge ruleId={entry.id} onClick={props.onRuleClick} />
              </div>
            );
          if (entry.type === 'removed')
            return (
              <div className="diff-row removed" key={'d' + entry.id}>
                <Trash2 size={14} /> 删除 <code>{entry.id}</code>
              </div>
            );
          if (entry.type === 'moved')
            return (
              <div className="diff-row moved" key={'m' + entry.id}>
                <ArrowDown size={14} /> 重排 <RuleBadge ruleId={entry.id} onClick={props.onRuleClick} /> #{entry.fromIndex + 1} → #
                {entry.toIndex + 1}
              </div>
            );
          return (
            <div className="diff-row changed" key={'c' + entry.id}>
              <AlertTriangle size={14} /> 修改 <RuleBadge ruleId={entry.id} onClick={props.onRuleClick} />
              <div className="field-changes">
                {entry.fields.map((change) => (
                  <div key={change.field} className="field-change">
                    <code>{FIELD_LABELS[change.field] ?? change.field}</code>:{' '}
                    <span className="old">{fieldValue(change.from)}</span> →{' '}
                    <span className="new">{fieldValue(change.to)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      <h4>样例查询</h4>
      {samplesDiff.entries
        .filter((entry) => entry.type !== 'unchanged')
        .map((entry) => {
          if (entry.type === 'added')
            return (
              <div className="diff-row added" key={'sa' + entry.id}>
                <Plus size={14} /> 新增样例 <code>{entry.id}</code>
              </div>
            );
          if (entry.type === 'removed')
            return (
              <div className="diff-row removed" key={'sd' + entry.id}>
                <Trash2 size={14} /> 删除样例 <code>{entry.id}</code>
              </div>
            );
          if (entry.type === 'moved')
            return (
              <div className="diff-row moved" key={'sm' + entry.id}>
                <ArrowDown size={14} /> 样例重排 <code>{entry.id}</code> #{entry.fromIndex + 1} → #{entry.toIndex + 1}
              </div>
            );
          return (
            <div className="diff-row changed" key={'sc' + entry.id}>
              <AlertTriangle size={14} /> 修改样例 <code>{entry.id}</code>
              <div className="field-changes">
                {entry.fields.map((change) => (
                  <div key={change.field} className="field-change">
                    <code>{FIELD_LABELS[change.field] ?? change.field}</code>:{' '}
                    <span className="old">{fieldValue(change.from)}</span> →{' '}
                    <span className="new">{fieldValue(change.to)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}

function DiagnosticsView(props: {diagnostics: Diagnostic[]; onRuleClick: (id: string) => void}) {
  if (props.diagnostics.length === 0) return <p className="hint">尚无诊断。运行模拟后展示不可达规则、覆盖与循环。</p>;
  return (
    <div className="diag-list">
      {props.diagnostics.map((diagnostic, index) => (
        <div key={index} className={'diag-row ' + diagnostic.severity}>
          <DiagnosticRow diagnostic={diagnostic} onRuleClick={props.onRuleClick} />
        </div>
      ))}
    </div>
  );
}

function DiagnosticRow(props: {diagnostic: Diagnostic; onRuleClick: (id: string) => void}) {
  const {diagnostic, onRuleClick} = props;
  return (
    <div className="diag-content">
      <span className="diag-code">{diagnostic.code}</span>
      <span>{diagnostic.message}</span>
      <span className="diag-rules">
        {diagnostic.ruleId ? <RuleBadge ruleId={diagnostic.ruleId} onClick={onRuleClick} /> : null}
        {diagnostic.otherRuleId ? <RuleBadge ruleId={diagnostic.otherRuleId} onClick={onRuleClick} /> : null}
        {diagnostic.sampleId ? <code className="scope-tag">{diagnostic.sampleId}</code> : null}
      </span>
    </div>
  );
};
