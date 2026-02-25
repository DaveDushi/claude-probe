/**
 * Dalton adapter — bridges Dalton markdown-based task management with Probe sessions.
 *
 * Reads .dalton/state.json and .dalton/phases/phase_N.md, translates tasks into
 * Probe session prompts, tracks task↔session mapping, and evaluates done gates.
 */

import fs from 'node:fs';
import path from 'node:path';

// ================================================================
// Types
// ================================================================

export interface DaltonState {
  current_phase: number;
  completed_tasks: string[];
  in_progress: string | null;
  last_updated: string;
}

export interface DaltonTask {
  id: string;           // "p1-3"
  phase: number;
  seq: number;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  type: string;
  priority: string;
  effort: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
}

export interface TaskMapping {
  probeSessionId: string;
  startedAt: number;
  status: 'active' | 'done' | 'failed';
  result?: string;
}

export interface ProbeMappingFile {
  tasks: Record<string, TaskMapping>;
}

export interface DoneGateResult {
  passed: boolean;
  reasons: string[];
  sessionStatus: string;
  resultText: string | null;
}

// HttpGet function signature — injected from probe.ts to avoid coupling
type HttpGetFn = (urlPath: string) => Promise<{ status: number; data: Record<string, unknown> | string }>;

// ================================================================
// Path helpers
// ================================================================

function daltonDir(cwd: string): string {
  return path.join(cwd, '.dalton');
}

function statePath(cwd: string): string {
  return path.join(daltonDir(cwd), 'state.json');
}

function mappingPath(cwd: string): string {
  return path.join(daltonDir(cwd), 'probe-mapping.json');
}

function phaseFilePath(cwd: string, phaseNum: number): string {
  return path.join(daltonDir(cwd), 'phases', `phase_${phaseNum}.md`);
}

// ================================================================
// State I/O
// ================================================================

export function readDaltonState(cwd: string): DaltonState | null {
  const p = statePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeDaltonState(cwd: string, state: DaltonState): void {
  state.last_updated = new Date().toISOString();
  fs.writeFileSync(statePath(cwd), JSON.stringify(state, null, 2) + '\n');
}

export function readMapping(cwd: string): ProbeMappingFile {
  const p = mappingPath(cwd);
  if (!fs.existsSync(p)) return { tasks: {} };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { tasks: {} };
  }
}

export function writeMapping(cwd: string, mapping: ProbeMappingFile): void {
  fs.writeFileSync(mappingPath(cwd), JSON.stringify(mapping, null, 2) + '\n');
}

export function linkTaskToSession(cwd: string, taskId: string, probeSessionId: string): void {
  const mapping = readMapping(cwd);
  mapping.tasks[taskId] = {
    probeSessionId,
    startedAt: Date.now(),
    status: 'active',
  };
  writeMapping(cwd, mapping);
}

export function getSessionForTask(cwd: string, taskId: string): TaskMapping | null {
  const mapping = readMapping(cwd);
  return mapping.tasks[taskId] || null;
}

// ================================================================
// Phase file parser
// ================================================================

const RE_TASK_HEADING = /^###\s+(p(\d+)-(\d+)):\s*(.+)$/;
const RE_STATUS = /\*\*Status\*\*:\s*(\w+)/;
const RE_TYPE = /\*\*Type\*\*:\s*(.+)/;
const RE_PRIORITY = /\*\*Priority\*\*:\s*(\w+)/;
const RE_EFFORT = /\*\*(?:Estimated\s+)?Effort\*\*:\s*(\w+)/;
const RE_DESCRIPTION = /\*\*Description\*\*:\s*(.+)/;
const RE_DEPENDENCIES = /\*\*Dependencies\*\*:\s*(.+)/;
const RE_CRITERIA_ITEM = /^\s*-\s*\[[ x]\]\s*(.+)$/;

export function parsePhaseFile(cwd: string, phaseNum: number): DaltonTask[] {
  const filePath = phaseFilePath(cwd, phaseNum);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const tasks: DaltonTask[] = [];
  let current: Partial<DaltonTask> | null = null;
  let inCriteria = false;

  for (const line of lines) {
    const headingMatch = line.match(RE_TASK_HEADING);
    if (headingMatch) {
      // Save previous task
      if (current && current.id) {
        tasks.push(finishTask(current));
      }
      current = {
        id: headingMatch[1],
        phase: parseInt(headingMatch[2], 10),
        seq: parseInt(headingMatch[3], 10),
        title: headingMatch[4].trim(),
        status: 'pending',
        type: '',
        priority: 'medium',
        effort: 'medium',
        description: '',
        acceptanceCriteria: [],
        dependencies: [],
      };
      inCriteria = false;
      continue;
    }

    if (!current) continue;

    // Check for metadata lines
    const statusMatch = line.match(RE_STATUS);
    if (statusMatch) {
      current.status = statusMatch[1].toLowerCase() as DaltonTask['status'];
      inCriteria = false;
      continue;
    }

    const typeMatch = line.match(RE_TYPE);
    if (typeMatch) {
      current.type = typeMatch[1].trim();
      inCriteria = false;
      continue;
    }

    const priorityMatch = line.match(RE_PRIORITY);
    if (priorityMatch) {
      current.priority = priorityMatch[1].toLowerCase();
      inCriteria = false;
      continue;
    }

    const effortMatch = line.match(RE_EFFORT);
    if (effortMatch) {
      current.effort = effortMatch[1].toLowerCase();
      inCriteria = false;
      continue;
    }

    const descMatch = line.match(RE_DESCRIPTION);
    if (descMatch) {
      current.description = descMatch[1].trim();
      inCriteria = false;
      continue;
    }

    const depsMatch = line.match(RE_DEPENDENCIES);
    if (depsMatch) {
      const raw = depsMatch[1].trim();
      if (raw.toLowerCase() !== 'none') {
        current.dependencies = raw.split(/[,\s]+/).filter(d => d.match(/^p\d+-\d+$/));
      }
      inCriteria = false;
      continue;
    }

    // Acceptance criteria section
    if (line.match(/\*\*Acceptance\s+Criteria\*\*/i)) {
      inCriteria = true;
      continue;
    }

    if (inCriteria) {
      const criteriaMatch = line.match(RE_CRITERIA_ITEM);
      if (criteriaMatch) {
        current.acceptanceCriteria!.push(criteriaMatch[1].trim());
      } else if (line.trim() === '' || line.match(/^\*\*/)) {
        inCriteria = false;
      }
    }
  }

  // Don't forget the last task
  if (current && current.id) {
    tasks.push(finishTask(current));
  }

  return tasks;
}

function finishTask(partial: Partial<DaltonTask>): DaltonTask {
  return {
    id: partial.id!,
    phase: partial.phase ?? 0,
    seq: partial.seq ?? 0,
    title: partial.title ?? '',
    status: partial.status ?? 'pending',
    type: partial.type ?? '',
    priority: partial.priority ?? 'medium',
    effort: partial.effort ?? 'medium',
    description: partial.description ?? '',
    acceptanceCriteria: partial.acceptanceCriteria ?? [],
    dependencies: partial.dependencies ?? [],
  };
}

export function getTask(cwd: string, taskId: string): DaltonTask | null {
  const match = taskId.match(/^p(\d+)-(\d+)$/);
  if (!match) return null;
  const phaseNum = parseInt(match[1], 10);
  const tasks = parsePhaseFile(cwd, phaseNum);
  return tasks.find(t => t.id === taskId) || null;
}

export function getNextTask(cwd: string): DaltonTask | null {
  const state = readDaltonState(cwd);
  if (!state) return null;

  const completedSet = new Set(state.completed_tasks);
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };

  // Search current phase, then subsequent phases
  for (let p = state.current_phase; p <= state.current_phase + 5; p++) {
    const tasks = parsePhaseFile(cwd, p);
    if (tasks.length === 0 && p > state.current_phase) break;

    // Filter to pending tasks with satisfied dependencies
    const candidates = tasks.filter(t =>
      t.status === 'pending' &&
      !completedSet.has(t.id) &&
      t.dependencies.every(d => completedSet.has(d))
    );

    // Sort by priority then sequence
    candidates.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 1;
      const pb = priorityOrder[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.seq - b.seq;
    });

    if (candidates.length > 0) return candidates[0];
  }

  return null;
}

// ================================================================
// Task status update in phase markdown
// ================================================================

export function updateTaskStatus(cwd: string, taskId: string, newStatus: string): void {
  const match = taskId.match(/^p(\d+)-(\d+)$/);
  if (!match) return;
  const phaseNum = parseInt(match[1], 10);
  const filePath = phaseFilePath(cwd, phaseNum);
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  let inTargetTask = false;
  let statusUpdated = false;

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(RE_TASK_HEADING);
    if (headingMatch) {
      inTargetTask = headingMatch[1] === taskId;
      continue;
    }

    if (inTargetTask && !statusUpdated && RE_STATUS.test(lines[i])) {
      lines[i] = lines[i].replace(RE_STATUS, `**Status**: ${newStatus}`);
      statusUpdated = true;
      break;
    }
  }

  if (statusUpdated) {
    fs.writeFileSync(filePath, lines.join('\n'));
  }
}

// ================================================================
// Prompt builder
// ================================================================

export function buildTaskPrompt(task: DaltonTask, cwd: string): string {
  const parts: string[] = [];

  parts.push(`You are working on task ${task.id} for the project at ${cwd}.`);
  parts.push('');
  parts.push(`## Task: ${task.title}`);

  const meta: string[] = [];
  if (task.type) meta.push(`Type: ${task.type}`);
  if (task.effort) meta.push(`Effort: ${task.effort}`);
  if (meta.length) parts.push(meta.join(' | '));

  if (task.description) {
    parts.push('');
    parts.push('## Description');
    parts.push(task.description);
  }

  if (task.acceptanceCriteria.length > 0) {
    parts.push('');
    parts.push('## Acceptance Criteria');
    for (const c of task.acceptanceCriteria) {
      parts.push(`- [ ] ${c}`);
    }
  }

  parts.push('');
  parts.push('## Instructions');
  parts.push('- Work in the project directory provided');
  parts.push('- Run tests after implementation if a test suite exists');
  parts.push('- When complete, confirm each acceptance criterion is met');

  return parts.join('\n');
}

// ================================================================
// Done gate
// ================================================================

export async function evaluateDoneGate(
  httpGet: HttpGetFn,
  cwd: string,
  taskId: string,
): Promise<DoneGateResult> {
  const mapping = getSessionForTask(cwd, taskId);
  if (!mapping) {
    return { passed: false, reasons: ['no session mapped to this task'], sessionStatus: 'unknown', resultText: null };
  }

  const sid = mapping.probeSessionId;

  // Check session status
  const statusRes = await httpGet(`/api/sessions/${sid}/status`);
  if (statusRes.status !== 200) {
    return { passed: false, reasons: ['could not reach session'], sessionStatus: 'unreachable', resultText: null };
  }

  const s = statusRes.data as Record<string, unknown>;
  const sessionStatus = (s.status as string) || 'unknown';

  // Session must be terminal
  if (sessionStatus !== 'done') {
    const reasons = [`session is ${sessionStatus}`];
    if (s.stuckForMs && (s.stuckForMs as number) > 60000) {
      reasons.push(`stuck for ${Math.round((s.stuckForMs as number) / 1000)}s`);
    }
    return { passed: false, reasons, sessionStatus, resultText: null };
  }

  // Check for errors
  if (s.error) {
    return {
      passed: false,
      reasons: [`session ended with error: ${s.error}`],
      sessionStatus,
      resultText: null,
    };
  }

  // Get result
  const resultRes = await httpGet(`/api/sessions/${sid}/result`);
  let resultText: string | null = null;
  if (resultRes.status === 200) {
    const r = resultRes.data as Record<string, unknown>;
    if (r.isError) {
      return {
        passed: false,
        reasons: ['session result indicates error'],
        sessionStatus,
        resultText: typeof r.result === 'string' ? r.result : null,
      };
    }
    resultText = typeof r.result === 'string' ? r.result : (r.result ? JSON.stringify(r.result) : null);
  }

  if (!resultText) {
    return { passed: false, reasons: ['session has no result text'], sessionStatus, resultText };
  }

  return { passed: true, reasons: ['session done with result'], sessionStatus, resultText };
}

// ================================================================
// Complete a task (update all state files)
// ================================================================

export function completeDaltonTask(cwd: string, taskId: string, resultText: string | null): void {
  // Update mapping
  const mapping = readMapping(cwd);
  if (mapping.tasks[taskId]) {
    mapping.tasks[taskId].status = 'done';
    if (resultText) mapping.tasks[taskId].result = resultText;
    writeMapping(cwd, mapping);
  }

  // Update phase markdown
  updateTaskStatus(cwd, taskId, 'completed');

  // Update state.json
  const state = readDaltonState(cwd);
  if (state) {
    if (!state.completed_tasks.includes(taskId)) {
      state.completed_tasks.push(taskId);
    }
    if (state.in_progress === taskId) {
      state.in_progress = null;
    }
    writeDaltonState(cwd, state);
  }
}

// ================================================================
// Fail a task (update mapping only, keep Dalton state as in_progress)
// ================================================================

export function failDaltonTask(cwd: string, taskId: string, reason: string): void {
  const mapping = readMapping(cwd);
  if (mapping.tasks[taskId]) {
    mapping.tasks[taskId].status = 'failed';
    mapping.tasks[taskId].result = reason;
    writeMapping(cwd, mapping);
  }
}

// ================================================================
// Init & Add
// ================================================================

export function initDalton(cwd: string, phaseCount: number = 1): void {
  const dir = daltonDir(cwd);
  if (fs.existsSync(statePath(cwd))) {
    throw new Error(`.dalton/state.json already exists in ${cwd}`);
  }

  fs.mkdirSync(path.join(dir, 'phases'), { recursive: true });

  const state: DaltonState = {
    current_phase: 1,
    completed_tasks: [],
    in_progress: null,
    last_updated: new Date().toISOString(),
  };
  fs.writeFileSync(statePath(cwd), JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(mappingPath(cwd), JSON.stringify({ tasks: {} }, null, 2) + '\n');

  for (let i = 1; i <= phaseCount; i++) {
    const fp = phaseFilePath(cwd, i);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, `# Phase ${i}\n\n`);
    }
  }
}

export interface AddTaskOpts {
  phase: number;
  title: string;
  type?: string;
  priority?: string;
  effort?: string;
  description?: string;
  dependencies?: string[];
  acceptanceCriteria?: string[];
}

export function addTask(cwd: string, opts: AddTaskOpts): string {
  if (!fs.existsSync(statePath(cwd))) {
    throw new Error(`.dalton/state.json not found — run dalton init first`);
  }

  const fp = phaseFilePath(cwd, opts.phase);

  // Create phase file if it doesn't exist
  if (!fs.existsSync(fp)) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `# Phase ${opts.phase}\n\n`);
  }

  // Find highest existing seq for this phase
  const existing = parsePhaseFile(cwd, opts.phase);
  const maxSeq = existing.reduce((max, t) => Math.max(max, t.seq), 0);
  const seq = maxSeq + 1;
  const taskId = `p${opts.phase}-${seq}`;

  // Build markdown block
  const lines: string[] = [];
  lines.push(`### ${taskId}: ${opts.title}`);
  lines.push(`**Status**: pending`);
  lines.push(`**Type**: ${opts.type || 'feature'}`);
  lines.push(`**Priority**: ${opts.priority || 'medium'}`);
  lines.push(`**Effort**: ${opts.effort || 'medium'}`);
  lines.push(`**Description**: ${opts.description || opts.title}`);
  lines.push(`**Dependencies**: ${opts.dependencies?.length ? opts.dependencies.join(', ') : 'none'}`);
  if (opts.acceptanceCriteria?.length) {
    lines.push(`**Acceptance Criteria**:`);
    for (const c of opts.acceptanceCriteria) {
      lines.push(`- [ ] ${c}`);
    }
  }
  lines.push('');

  // Append to phase file
  const content = fs.readFileSync(fp, 'utf-8');
  const separator = content.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(fp, content + separator + lines.join('\n') + '\n');

  return taskId;
}
