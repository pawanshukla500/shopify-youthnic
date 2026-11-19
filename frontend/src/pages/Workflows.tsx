import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BranchedStep, Definition, StepDefinition, StepsConfiguration, ToolboxConfiguration, ValidatorConfiguration } from 'sequential-workflow-designer'
import {
  SequentialWorkflowDesigner,
  useSequentialWorkflowDesignerController,
  useStepEditor,
  wrapDefinition,
  type WrappedDefinition,
} from 'sequential-workflow-designer-react'
import 'sequential-workflow-designer/css/designer.css'
import 'sequential-workflow-designer/css/designer-light.css'
import 'sequential-workflow-designer/css/designer-dark.css'
import { apiError, getWorkflowDesign, lookupOrders, saveWorkflowDesign } from '../api'
import { Button, ErrorBox, FormField, Icon, LoadingState, PageIntro, Panel, StatusBadge, useDocumentTitle, useToast } from '../components/UI'
import { useTheme } from '../context/ThemeContext'
import { formatMoney, labelize, normalizeCourierName } from '../lib'
import {
  activeReturn,
  DEFAULT_WORKFLOW,
  FACT_KEYS,
  findStep,
  invalidTokens,
  routeProgress,
  safeColor,
  orderFacts,
  pickOrder,
  resolveOrderPath,
  type OrderPath,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../workflow-map'
import './Workflows.css'

// ─── Step types: four kinds of stage plus a decision ────────────────────────

const STEP_KINDS: Record<string, { label: string; color: string; path: string }> = {
  order: { label: 'Order stage', color: '#2563eb', path: 'M6 2h9l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM8 11h8M8 15h8M8 19h5' },
  shipping: { label: 'Shipping stage', color: '#059669', path: 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z' },
  returns: { label: 'Return stage', color: '#d97706', path: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3' },
  money: { label: 'Money stage', color: '#7c3aed', path: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' },
  decision: { label: 'Decision', color: '#1e3a8a', path: 'M6 3v12M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a9 9 0 0 1-9 9' },
}

// Swatches offered in the step editor; "Auto" uses the kind colour above.
const PALETTE = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#dc2626', '#db2777', '#0891b2', '#475569']

/** Colour a step is drawn in: the one picked in the editor, else its kind's. */
const stepColor = (step: WorkflowStep | null) => safeColor(step?.properties?.color) ?? STEP_KINDS[step?.type ?? '']?.color ?? '#64748b'

const iconUrl = (type: string) => {
  const kind = STEP_KINDS[type] ?? STEP_KINDS.order
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${kind.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${kind.path}"/></svg>`
  )}`
}

const toolbox: ToolboxConfiguration = {
  groups: [
    {
      name: 'Steps',
      steps: [
        ...['order', 'shipping', 'returns', 'money'].map((type) => ({
          componentType: 'task',
          type,
          name: STEP_KINDS[type].label.replace(/ stage$/, ''),
          properties: { states: '', note: '' },
        })),
        {
          componentType: 'switch',
          type: 'decision',
          name: 'Decision',
          properties: { conditions: { Yes: '', No: '' }, note: '' },
          branches: { Yes: [], No: [] },
        } as StepDefinition,
      ],
    },
  ],
}

const stepsConfiguration: StepsConfiguration = { iconUrlProvider: (_componentType, type) => iconUrl(type) }

// A typo in a token list can never match an order, so flag it on the canvas.
const validator: ValidatorConfiguration = {
  step: (step) =>
    step.componentType === 'switch'
      ? Object.values((step.properties.conditions as Record<string, string>) || {}).every((text) => invalidTokens(text).length === 0)
      : invalidTokens(step.properties.states).length === 0,
}

const asWorkflow = (definition: WrappedDefinition) => definition.value as unknown as WorkflowDefinition
const wrap = (workflow: WorkflowDefinition) => wrapDefinition(structuredClone(workflow) as unknown as Definition)

// ─── Editors (rendered by the designer in its own React root: no app context) ─

function TokenHint() {
  return <span className="field-hint">Comma separated, e.g. <code>order:IN_TRANSIT, shipment:IN_TRANSIT</code>. <code>key:*</code> = any value, <code>a&amp;b</code> = both.</span>
}

function TokenErrors({ text }: { text: unknown }) {
  const bad = invalidTokens(text)
  return bad.length ? <span className="wf-token-error" role="alert">Not a token: {bad.join(', ')}</span> : null
}

function BranchEditor() {
  const { step, properties, setProperty, notifyChildrenChanged, isReadonly } = useStepEditor<BranchedStep>()
  const conditions: Record<string, string> = (properties.conditions as Record<string, string>) || {}
  const names = Object.keys(step.branches)

  // Rebuild in place so branch order (left to right on the canvas) is kept.
  const setBranches = (entries: Array<[string, BranchedStep['branches'][string]]>, nextConditions: Record<string, string>) => {
    for (const key of Object.keys(step.branches)) delete step.branches[key]
    for (const [key, value] of entries) step.branches[key] = value
    setProperty('conditions', nextConditions)
    notifyChildrenChanged()
  }

  const rename = (from: string, raw: string) => {
    const to = raw.trim()
    if (!to || to === from || names.includes(to)) return
    setBranches(
      Object.entries(step.branches).map(([key, value]) => [key === from ? to : key, value]),
      Object.fromEntries(names.map((key) => [key === from ? to : key, conditions[key] ?? '']))
    )
  }

  const add = () => {
    let n = names.length + 1
    while (names.includes(`Branch ${n}`)) n += 1
    setBranches([...Object.entries(step.branches), [`Branch ${n}`, []]], { ...conditions, [`Branch ${n}`]: '' })
  }

  const remove = (name: string) => {
    if (names.length <= 1) return
    const { [name]: _removed, ...rest } = conditions
    setBranches(Object.entries(step.branches).filter(([key]) => key !== name), rest)
  }

  return (
    <div className="wf-branches">
      <span className="field-label">Branches · condition</span>
      {names.map((name) => (
        <div className="wf-branch" key={name}>
          <div className="wf-branch-head">
            <input
              aria-label="Branch name"
              defaultValue={name}
              readOnly={isReadonly}
              onBlur={(e) => rename(name, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <button type="button" className="wf-icon-button" aria-label={`Remove branch ${name}`} disabled={isReadonly || names.length <= 1} onClick={() => remove(name)}>
              <Icon name="close" size={13} />
            </button>
          </div>
          <textarea
            aria-label={`Condition for ${name}`}
            rows={2}
            value={conditions[name] ?? ''}
            readOnly={isReadonly}
            placeholder="empty = default branch"
            onChange={(e) => setProperty('conditions', { ...conditions, [name]: e.target.value })}
          />
          <TokenErrors text={conditions[name]} />
        </div>
      ))}
      <button type="button" className="button button-secondary button-small" disabled={isReadonly} onClick={add}>
        <Icon name="plus" size={13} /> Add branch
      </button>
      <span className="field-hint">An order takes the first branch whose condition matches; otherwise the branch holding its stage; otherwise the empty (default) one.</span>
      <TokenHint />
    </div>
  )
}

function StepEditor() {
  const { componentType, type, name, setName, properties, setProperty, isReadonly } = useStepEditor()
  return (
    <div className="wf-editor">
      <p className="eyebrow">{STEP_KINDS[type]?.label ?? 'Step'}</p>
      <FormField label="Name">
        <input value={name} readOnly={isReadonly} onChange={(e) => setName(e.target.value)} />
      </FormField>
      {componentType === 'switch' ? (
        <BranchEditor />
      ) : (
        <FormField label="Order states shown here">
          <textarea rows={4} value={(properties.states as string) ?? ''} readOnly={isReadonly} onChange={(e) => setProperty('states', e.target.value)} />
          <TokenErrors text={properties.states} />
          <TokenHint />
        </FormField>
      )}
      <div className="wf-colors" role="group" aria-label="Step colour">
        <span className="field-label">Colour</span>
        <div className="wf-swatches">
          <button type="button" className={`wf-swatch is-auto ${safeColor(properties.color) ? '' : 'is-active'}`} disabled={isReadonly} onClick={() => setProperty('color', '')} aria-label="Automatic colour" title="Automatic (by kind)">
            Auto
          </button>
          {PALETTE.map((color) => (
            <button
              type="button"
              key={color}
              className={`wf-swatch ${properties.color === color ? 'is-active' : ''}`}
              style={{ background: color }}
              disabled={isReadonly}
              onClick={() => setProperty('color', color)}
              aria-label={`Colour ${color}`}
              aria-pressed={properties.color === color}
            />
          ))}
        </div>
      </div>
      <FormField label="Notes">
        <textarea rows={3} value={(properties.note as string) ?? ''} readOnly={isReadonly} onChange={(e) => setProperty('note', e.target.value)} />
      </FormField>
    </div>
  )
}

function RootEditor() {
  return (
    <div className="wf-editor">
      <p className="eyebrow">How mapping works</p>
      <p className="wf-editor-text">Select a step to edit it. Each stage lists the order states it stands for; each decision has a condition per branch. Look up an order to see where it sits.</p>
      <dl className="wf-token-list">
        {FACT_KEYS.map(({ key, values }) => (
          <div key={key}>
            <dt><code>{key}:</code></dt>
            <dd>{values}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// ─── Canvas CSS keyed on the designer's data-step-id attributes ─────────────
// Kind colours, connectors and animations live in Workflows.css; this adds the
// per-step colours picked in the editor and the trace of a looked-up order.

function canvasCss(workflow: WorkflowDefinition, path: OrderPath | null): string {
  const id = (stepId: string) => `[data-step-id="${CSS.escape(stepId)}"]`
  const rules: string[] = []
  const paint = (sequence: WorkflowStep[]) =>
    sequence.forEach((step) => {
      const color = safeColor(step.properties?.color)
      if (color) rules.push(`.wf-canvas .${step.componentType === 'switch' ? 'sqd-step-switch' : 'sqd-step-task'}${id(step.id)} { --wf-c: ${color}; }`)
      Object.values(step.branches || {}).forEach(paint)
    })
  paint(workflow.sequence)
  if (!path) return rules.join('\n')

  const lit = [...path.passedIds, ...(path.currentId ? [path.currentId] : [])]
  if (lit.length) {
    rules.push(`${lit.map((s) => `.wf-canvas.is-tracing .sqd-step-task${id(s)}, .wf-canvas.is-tracing .sqd-step-switch${id(s)} > .sqd-label`).join(', ')} { opacity: 1; }`)
  }
  if (path.passedIds.length) {
    rules.push(`${path.passedIds.map((s) => `.wf-canvas.is-tracing .sqd-step-task${id(s)}`).join(', ')} { --wf-tint: 24%; --wf-stroke: 2.5px; }`)
  }
  if (path.currentId) {
    rules.push(`.wf-canvas.is-tracing .sqd-step-task${id(path.currentId)} > .sqd-step-task-rect { animation: wf-run 0.8s linear infinite, wf-glow 1.6s ease-in-out infinite; stroke: #10b981; stroke-width: 3px; stroke-dasharray: 8 5; fill: #d1fae5; }`)
  }
  return rules.join('\n')
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function Workflows() {
  useDocumentTitle('Workflow Designer')
  const designQuery = useQuery({ queryKey: ['workflow-design'], queryFn: getWorkflowDesign, staleTime: Infinity, retry: 1 })

  if (designQuery.isLoading) return <LoadingState label="Loading workflow…" />
  // Never fall back to the default here: saving it would overwrite the stored design.
  if (designQuery.isError) return <ErrorBox message={apiError(designQuery.error)} onRetry={() => designQuery.refetch()} />
  return <WorkflowDesigner saved={designQuery.data?.definition ?? null} savedAt={designQuery.data?.updatedAt ?? null} />
}

function WorkflowDesigner({ saved, savedAt }: { saved: WorkflowDefinition | null; savedAt: string | null }) {
  const { toast } = useToast()
  const { theme } = useTheme()
  const queryClient = useQueryClient()
  const controller = useSequentialWorkflowDesignerController()
  const [definition, setDefinition] = useState(() => wrap(saved ?? DEFAULT_WORKFLOW))
  const [dirty, setDirty] = useState(false)
  const [lookup, setLookup] = useState('')
  const [query, setQuery] = useState('')
  const [chosenId, setChosenId] = useState<number | null>(null)

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const ordersQuery = useQuery({
    queryKey: ['workflow-lookup', query],
    queryFn: () => lookupOrders(query),
    enabled: Boolean(query),
    retry: false,
  })
  const matches = ordersQuery.data ?? []
  const order = (chosenId ? matches.find((entry) => entry.id === chosenId) : null) ?? pickOrder(matches, query)
  const facts = useMemo(() => (order ? orderFacts(order) : []), [order])
  const path = useMemo(() => (order ? resolveOrderPath(asWorkflow(definition), facts) : null), [order, facts, definition])

  // Centre the current step on lookup, and again when the designer remounts (theme switch).
  const currentId = path?.currentId ?? null
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId
  const focusCurrent = () => {
    if (currentIdRef.current && controller.isReady()) controller.moveViewportToStep(currentIdRef.current)
  }
  useEffect(focusCurrent, [currentId])

  // Counts edits so a save that finishes after a newer edit leaves that edit unsaved.
  const editCount = useRef(0)
  const save = useMutation({
    mutationFn: ({ snapshot }: { snapshot: WorkflowDefinition; edits: number }) => saveWorkflowDesign(snapshot),
    onSuccess: (result, { snapshot, edits }) => {
      if (editCount.current === edits) setDirty(false)
      queryClient.setQueryData(['workflow-design'], { definition: snapshot, updatedAt: result.updatedAt })
      toast('success', 'Workflow saved')
    },
    onError: (error) => toast('error', apiError(error)),
  })

  const replace = (workflow: WorkflowDefinition, isDirty: boolean) => {
    editCount.current += 1
    setDefinition(wrap(workflow))
    setDirty(isDirty)
  }

  const onLookup = (event: FormEvent) => {
    event.preventDefault()
    setChosenId(null)
    setQuery(lookup.trim())
  }

  const stepName = (id: string) => findStep(asWorkflow(definition).sequence, id)?.name ?? id
  const progress = path ? routeProgress(asWorkflow(definition), path) : null
  const shipment = order?.shipment
  const ret = activeReturn(order?.returns)

  return (
    <div className="wf-page">
      <PageIntro
        eyebrow="Order lifecycle"
        title="Workflow Designer"
        description="Design how orders move from checkout to settlement, then look up a real order to see where it sits."
      >
        <div className="wf-actions">
          <span className="wf-save-state">{dirty ? 'Unsaved changes' : savedAt ? `Saved ${new Date(savedAt).toLocaleString()}` : 'Default design (not saved yet)'}</span>
          {dirty && saved && (
            <Button type="button" className="button-secondary" onClick={() => replace(saved, false)}>
              Discard changes
            </Button>
          )}
          <Button
            type="button"
            className="button-secondary"
            onClick={() => window.confirm('Replace the canvas with the default Youthnic workflow? Nothing is saved until you press Save.') && replace(DEFAULT_WORKFLOW, true)}
          >
            <Icon name="refresh" size={14} /> Reset to default
          </Button>
          <Button type="button" className="button-primary" loading={save.isPending} disabled={!dirty && Boolean(saved)} onClick={() => save.mutate({ snapshot: structuredClone(asWorkflow(definition)), edits: editCount.current })}>
            <Icon name="check" size={14} /> Save workflow
          </Button>
        </div>
      </PageIntro>

      <div className="wf-layout">
        <div className={`wf-canvas ${path ? 'is-tracing' : ''}`}>
          <style>{canvasCss(asWorkflow(definition), path)}</style>
          <SequentialWorkflowDesigner
            // The wrapper ignores theme changes on a live designer, so remount.
            key={theme}
            definition={definition}
            onDefinitionChange={(next, event) => {
              setDefinition(next)
              // No event = the designer finished rendering (onReady), not an edit.
              if (event) {
                editCount.current += 1
                setDirty(true)
              } else focusCurrent()
            }}
            theme={theme}
            controller={controller}
            stepsConfiguration={stepsConfiguration}
            toolboxConfiguration={toolbox}
            validatorConfiguration={validator}
            controlBar
            undoStackSize={20}
            rootEditor={<RootEditor />}
            stepEditor={<StepEditor />}
          />
        </div>

        <aside className="wf-side">
          <Panel className="wf-lookup">
            <p className="eyebrow">Check an order</p>
            <form className="wf-lookup-form" onSubmit={onLookup}>
              <input
                aria-label="Order number or AWB"
                placeholder="#26YOU6590 or AWB"
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
              />
              <Button type="submit" className="button-primary button-small" loading={ordersQuery.isFetching} disabled={!lookup.trim()}>
                <Icon name="search" size={13} /> Find
              </Button>
              {query && (
                <Button type="button" className="button-secondary button-small" onClick={() => { setQuery(''); setLookup(''); setChosenId(null) }}>
                  Clear
                </Button>
              )}
            </form>

            {ordersQuery.isError && <ErrorBox compact message={apiError(ordersQuery.error)} />}
            {query && ordersQuery.isSuccess && !order && <p className="wf-muted">No order matches “{query}”.</p>}

            {order && path && (
              <div className="wf-result">
                <div className="wf-result-head">
                  <Link to={`/orders/${order.id}`} className="wf-order-link">{order.shopifyOrderName}</Link>
                  <StatusBadge status={order.status} />
                </div>
                <dl className="wf-facts">
                  <div><dt>Customer</dt><dd>{order.customerName}</dd></div>
                  <div><dt>Payment</dt><dd>{facts.includes('payment:COD') ? 'COD' : 'Prepaid'} · {labelize(order.financialStatus)} · {formatMoney(order.totalAmount, order.currency)}</dd></div>
                  <div><dt>Courier</dt><dd>{shipment?.waybillNumber ? normalizeCourierName(shipment.courier, shipment.labelUrl, shipment.waybillNumber) : '—'}</dd></div>
                  <div><dt>AWB</dt><dd className="wf-mono">{shipment?.waybillNumber || '—'}</dd></div>
                  <div><dt>Shipment</dt><dd>{shipment ? `${labelize(shipment.status)}${shipment.trackingStatus ? ` · ${shipment.trackingStatus}` : ''}` : '—'}</dd></div>
                  {ret && (
                    <div><dt>{ret.isExchange ? 'Exchange' : 'Return'}</dt><dd>{labelize(ret.returnStatus)}{ret.returnWaybillNumber ? ` · ${ret.returnWaybillNumber}` : ''}</dd></div>
                  )}
                </dl>

                <div className={`wf-where ${path.currentId ? 'is-found' : 'is-missing'}`}>
                  {path.currentId ? (
                    <><span>Sits at</span><strong>{stepName(path.currentId)}</strong></>
                  ) : (
                    <><strong>No step matches this order.</strong><span>Add one of its states (below) to a stage.</span></>
                  )}
                </div>

                {progress && (
                  <div className="wf-progress">
                    <div className="wf-progress-label">
                      <span>Stage {progress.stage} of {progress.stages}</span>
                      <span>{Math.round((progress.stage / progress.stages) * 100)}%</span>
                    </div>
                    <div
                      className="wf-progress-track"
                      role="progressbar"
                      aria-label="Progress along the workflow"
                      aria-valuemin={0}
                      aria-valuemax={progress.stages}
                      aria-valuenow={progress.stage}
                    >
                      <span className={progress.stage < progress.stages ? 'is-running' : ''} style={{ width: `${(progress.stage / progress.stages) * 100}%` }} />
                    </div>
                  </div>
                )}

                {path.currentId && (
                  <ol className="wf-route">
                    {[...path.passedIds, path.currentId].map((id) => {
                      const step = findStep(asWorkflow(definition).sequence, id)
                      return (
                        <li
                          key={id}
                          className={`${id === path.currentId ? 'is-current' : ''} ${step?.componentType === 'switch' ? 'is-decision' : ''}`}
                          style={{ '--dot': stepColor(step) } as CSSProperties}
                        >
                          {step?.name ?? id}
                          {path.branches[id] && <span className="wf-branch-taken"> → {path.branches[id]}</span>}
                        </li>
                      )
                    })}
                  </ol>
                )}

                <div className="wf-tokens" aria-label="Order states">
                  {facts.map((fact) => <code key={fact}>{fact}</code>)}
                </div>

                {matches.length > 1 && (
                  <div className="wf-other">
                    <span className="wf-muted">{matches.length} orders matched:</span>
                    {matches.map((entry) => (
                      <button type="button" key={entry.id} className={entry.id === order.id ? 'is-active' : ''} onClick={() => setChosenId(entry.id)}>
                        {entry.shopifyOrderName}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!query && <p className="wf-muted">Paste an order number or AWB. The route it took lights up in colour, the current step runs in green and the rest fades.</p>}
          </Panel>
        </aside>
      </div>
    </div>
  )
}
