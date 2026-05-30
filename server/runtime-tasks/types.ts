export interface TaskCycleResult {
  sleepMs: number;
  status: string;
  detail?: Record<string, unknown> | null;
}

export interface TaskStartContext {
  reason: string;
  signal?: AbortSignal;
}

export interface TaskStatusSnapshot {
  key: string;
  label: string;
  enabled: boolean;
  running: boolean;
  pendingRun: boolean;
  runCount: number;
  status: string;
  lastReason: string | null;
  lastError: string | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  nextRunAt: number | null;
  detail: Record<string, unknown> | null;
}

export interface TaskDefinition {
  key: string;
  label: string;
  start(context: TaskStartContext): Promise<void>;
  stop(signal?: string): Promise<void>;
  runNow(reason: string): Promise<void>;
  getStatus(): TaskStatusSnapshot;
}

export interface RuntimeTaskRegistry {
  startAll(): Promise<void>;
  stopAll(signal?: string): Promise<void>;
  runTaskNow(key: string, reason: string): Promise<void>;
  getTask(key: string): TaskDefinition | null;
  listStatuses(): TaskStatusSnapshot[];
}

export interface LoopTaskOptions {
  key: string;
  label: string;
  autoStart?: boolean;
  cycle: (context: { reason: string; signal?: AbortSignal }) => Promise<TaskCycleResult>;
  onStart?: (context: TaskStartContext) => Promise<void> | void;
  onStop?: (signal?: string) => Promise<void> | void;
}

export interface DefaultRuntimeTaskOptions {
  embedTelegramTasks?: boolean;
}
