import type { RuntimeTaskRegistry, TaskDefinition } from './types';

export function createTaskRegistry(tasks: TaskDefinition[]): RuntimeTaskRegistry {
  const taskMap = new Map(tasks.map((task) => [task.key, task] as const));

  return {
    async startAll() {
      for (const task of tasks) {
        await task.start({ reason: 'startup' });
      }
    },
    async stopAll(signal?: string) {
      for (const task of tasks) {
        await task.stop(signal);
      }
    },
    async runTaskNow(key: string, reason: string) {
      const task = taskMap.get(key);
      if (!task) {
        throw new Error(`unknown task: ${key}`);
      }
      await task.runNow(reason);
    },
    getTask(key: string) {
      return taskMap.get(key) || null;
    },
    listStatuses() {
      return tasks.map((task) => task.getStatus());
    },
  };
}
